// Node 24+: node --import tsx --experimental-test-module-mocks --test tests/race.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import { once } from 'node:events';
import { mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

let checkImpl;
let llmImpl;
let server;
mock.module('../src/policy.ts', { namedExports: {
  check: (input) => checkImpl(input), scanContent: async () => null, THRESHOLDS: {},
} });
mock.module('../src/llm.ts', { namedExports: { systemTwo: (input) => llmImpl(input) } });
mock.module('../src/config.ts', { namedExports: { config: { port: 0, llm: { model: 'test', baseURL: 'local' } } } });
mock.module('node:http', { namedExports: { ...http, createServer: (...args) => {
  server = http.createServer(...args);
  return server;
} } });
const { runRace } = await import('../src/race.ts');
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/race-cases.json', import.meta.url)));
const result = (verdict = 'allow') => ({ decision: { verdict }, cost: { jev: 0.01, llm: 0.02 } });

await test('24 fixtures use placeholder hosts, known verdicts, and the required mix', () => {
  assert.equal(fixtures.length, 24);
  for (const item of fixtures) {
    assert.deepEqual(Object.keys(item).sort(), ['expected', 'goal', 'tool_input', 'tool_name']);
    assert.ok(['allow', 'ask', 'deny'].includes(item.expected));
    for (const url of JSON.stringify(item).matchAll(/https?:\/\/([^/\s"\\]+)/g)) {
      assert.match(url[1], /(^|\.)example\.invalid$/);
    }
  }
  assert.ok(fixtures.slice(0, 10).every((item) => item.expected === 'allow'));
  assert.ok(fixtures.slice(10, 16).every((item) => item.expected === 'allow'));
  assert.ok(fixtures.slice(16).every((item) => item.expected !== 'allow'));
});

await test('both lanes overlap, cap concurrency at six, and account for every result', async () => {
  const active = { flinch: 0, llm: 0 }, peak = { flinch: 0, llm: 0 };
  const inputs = { flinch: [], llm: [] };
  let overlapped = false;
  async function judge(lane, input) {
    inputs[lane].push(input);
    peak[lane] = Math.max(peak[lane], ++active[lane]);
    if (active.flinch && active.llm) overlapped = true;
    await delay(inputs[lane].length % 3 + 2);
    active[lane]--;
    return lane === 'flinch' ? result() : { verdict: 'deny', costUsd: 0.04 };
  }
  checkImpl = (input) => judge('flinch', input);
  llmImpl = (input) => judge('llm', input);
  const events = [];
  await runRace(fixtures, (event) => events.push(event));
  assert.ok(overlapped);
  assert.deepEqual(peak, { flinch: 6, llm: 6 });
  assert.equal(events.length, 50);
  for (const lane of ['flinch', 'llm']) {
    const rows = events.filter((event) => event.lane === lane && !event.done);
    const done = events.filter((event) => event.lane === lane && event.done);
    assert.equal(rows.length, 24);
    assert.equal(new Set(rows.map((row) => row.index)).size, 24);
    assert.equal(done.length, 1);
    assert.equal(events.filter((event) => event.lane === lane).at(-1), done[0]);
    assert.equal(done[0].total, 24);
    assert.equal(done[0].correct, rows.filter((row) => row.correct).length);
    assert.ok(Math.abs(done[0].total_cost_usd - (lane === 'flinch' ? 0.72 : 0.96)) < 1e-10);
    assert.ok(done[0].elapsed_ms >= 0);
    for (const row of rows) {
      assert.equal(row.expected, fixtures[row.index].expected);
      assert.equal(row.correct, row.verdict === row.expected);
      assert.ok(row.latency_ms >= 0);
    }
  }
  assert.deepEqual(inputs.flinch.map((input) => input.session_id), Array(24).fill('race'));
  assert.ok(inputs.flinch.every((input) => input.tainted === false));
  for (const [index, input] of inputs.llm.entries()) {
    assert.deepEqual(input, { user_goal: fixtures[index].goal,
      tool_call: { tool: fixtures[index].tool_name, input: fixtures[index].tool_input }, classifier_signals: {} });
  }
});

await test('null LLM results ask, and empty lanes complete without model calls', async () => {
  checkImpl = async () => result('ask');
  llmImpl = async () => null;
  const events = [];
  await runRace([{ ...fixtures[0], expected: 'ask' }], (event) => events.push(event));
  const row = events.find((event) => event.lane === 'llm' && !event.done);
  assert.equal(row.verdict, 'ask');
  assert.equal(row.cost_usd, 0);
  assert.equal(row.correct, true);
  checkImpl = llmImpl = () => { throw new Error('unexpected model call'); };
  const empty = [];
  await runRace([], (event) => empty.push(event));
  assert.equal(empty.length, 2);
  assert.ok(empty.every((event) => event.done && event.total === 0 && event.total_cost_usd === 0));
});

await test('unexpected failures wait for outstanding work in both lanes', async () => {
  let pending = 0;
  checkImpl = async (input) => {
    if (input.goal === fixtures[0].goal) throw new Error('test failure');
    pending++;
    await delay(15);
    pending--;
    return result();
  };
  llmImpl = async () => { pending++; await delay(20); pending--; return null; };
  await assert.rejects(runRace(fixtures.slice(0, 7), () => {}), /test failure/);
  assert.equal(pending, 0);
});

await test('SSE lifecycle, 409 lock, disconnect, error recovery, and embedded fixture', async (t) => {
  await import('../src/server.ts');
  if (!server.listening) await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + '/race');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /new EventSource\('\/api\/race'\)/);
  assert.ok(!html.includes('<!-- RACE_CASES -->'));
  assert.deepEqual(JSON.parse(html.match(/<script id="race-cases" type="application\/json">(.*?)<\/script>/s)[1]), fixtures);
  assert.equal((await fetch(base + '/api/race', { method: 'HEAD' })).status, 204);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  checkImpl = async () => { await gate; return result(); };
  llmImpl = async () => { await gate; return null; };
  const first = await fetch(base + '/api/race');
  assert.match(first.headers.get('content-type'), /text\/event-stream/);
  assert.equal((await fetch(base + '/api/race')).status, 409);
  assert.equal((await fetch(base + '/api/race', { method: 'HEAD' })).headers.get('x-race-running'), 'true');
  release();
  const events = (await first.text()).split('\n\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.equal(events.length, 51);
  assert.deepEqual(events.at(-1), { finished: true });
  assert.equal((await fetch(base + '/api/race', { method: 'HEAD' })).status, 204);

  let releaseDisconnect;
  const disconnectGate = new Promise((resolve) => { releaseDisconnect = resolve; });
  checkImpl = async () => { await disconnectGate; return result(); };
  const controller = new AbortController();
  const disconnected = await fetch(base + '/api/race', { signal: controller.signal });
  controller.abort();
  await disconnected.body.cancel().catch(() => {});
  assert.equal((await fetch(base + '/api/race')).status, 409);
  releaseDisconnect();
  for (let i = 0; i < 50; i++) {
    if ((await fetch(base + '/api/race', { method: 'HEAD' })).headers.get('x-race-running') === 'false') break;
    await delay(5);
  }
  assert.equal((await fetch(base + '/api/race', { method: 'HEAD' })).headers.get('x-race-running'), 'false');

  checkImpl = async () => { throw new Error('synthetic failure'); };
  const failed = await fetch(base + '/api/race');
  assert.match(await failed.text(), /"error":"Race failed/);
  assert.equal((await fetch(base + '/api/race', { method: 'HEAD' })).status, 204);
  checkImpl = async () => result();
  assert.match(await (await fetch(base + '/api/race')).text(), /"finished":true/);
  assert.equal((await fetch(base + '/api/events')).status, 200);
  assert.equal((await fetch(base + '/api/stats')).status, 200);
});
