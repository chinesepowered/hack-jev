import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { parseCases, renderReport, runCases, summarize, type EvalCase, type EvalRow } from "../scripts/eval.js";
import type { CheckResult } from "./policy.js";

const fixture = (id: string, expected: EvalCase["expected"] = ["allow"]): EvalCase => ({
  id, goal: "Run tests", tool_name: "Bash", tool_input: { command: "pnpm test" }, expected,
});
const result = (verdict: CheckResult["decision"]["verdict"], layer: CheckResult["decision"]["layer"]): CheckResult => ({
  decision: { verdict, layer, reason: "Synthetic test result" }, signals: {}, latency: { total: 0 },
  cost: { jev: 0, llm: 0 }, tokens: { jev_in: 0, llm_in: 0, llm_out: 0 },
});

test("eval fixture has exactly 30 valid cases, placeholder hosts, and fake secrets", async () => {
  const raw = await readFile(new URL("../fixtures/eval-cases.json", import.meta.url), "utf8");
  const cases = parseCases(JSON.parse(raw));
  assert.equal(cases.length, 30);
  for (const url of raw.matchAll(/https?:\/\/[^\s"']+/g)) {
    assert.equal(new URL(url[0]).hostname, "example.invalid");
  }
  assert.match(raw, /FAKE_EVAL_SECRET_NOT_VALID/);
});

test("rejects malformed fixtures and duplicate identifiers", () => {
  for (const value of [null, [], [fixture("x"), fixture("x")], [{ ...fixture("x"), expected: [] }],
    [{ ...fixture("x"), expected: ["tainted"] }], [{ ...fixture("x"), tool_input: [] }]]) {
    assert.throws(() => parseCases(value));
  }
});

test("runs at most six checks, once per case, and preserves fixture order", async () => {
  const cases = Array.from({ length: 17 }, (_, i) => fixture(String(i)));
  let active = 0;
  let peak = 0;
  const seen = new Set<string>();
  const rows = await runCases(cases, async (input) => {
    assert.equal(input.tainted, false);
    assert.equal(input.goal, "Run tests");
    assert.equal(input.tool_name, "Bash");
    assert.deepEqual(input.tool_input, { command: "pnpm test" });
    assert.ok(input.cwd);
    assert.ok(!seen.has(input.session_id));
    seen.add(input.session_id);
    peak = Math.max(peak, ++active);
    // Completion order deliberately differs from input order.
    await setTimeout(input.session_id === "eval-0" ? 20 : 1);
    active--;
    return result("allow", "rule");
  });
  assert.equal(peak, 6);
  assert.equal(active, 0);
  assert.equal(seen.size, cases.length);
  assert.deepEqual(rows.map((r) => r.test.id), cases.map((c) => c.id));
});

test("propagates unexpected checker failures instead of reporting fabricated verdicts", async () => {
  await assert.rejects(runCases([fixture("error")], async () => { throw new Error("fixture failure"); }), /fixture failure/);
});

test("scores acceptable verdict sets and reports layers, latency, and total/projected costs", () => {
  const rows: EvalRow[] = [
    { test: fixture("rule"), result: result("allow", "rule") },
    { test: fixture("jev", ["ask", "deny"]), result: { ...result("deny", "jev"), latency: { total: 10, jev: 10 }, cost: { jev: 0.001, llm: 0 } } },
    { test: fixture("llm", ["ask"]), result: { ...result("allow", "llm"), latency: { total: 110, jev: 30, llm: 80 }, cost: { jev: 0.002, llm: 0.004 } } },
    { test: fixture("fallback", ["deny", "ask"]), result: { ...result("ask", "fallback"), latency: { total: 50, jev: 50 } } },
  ];
  const s = summarize(rows);
  assert.equal(s.accuracy, 0.75);
  assert.equal(s.correct, 3);
  assert.deepEqual(s.confusion, {
    allow: { allow: 1, ask: 0, deny: 0 },
    "ask / deny": { allow: 0, ask: 1, deny: 1 },
    ask: { allow: 1, ask: 0, deny: 0 },
  });
  assert.deepEqual(s.layers, { rule: 1, jev: 1, llm: 1, fallback: 1 });
  assert.deepEqual(s.layerShares, { rule: 0.25, jev: 0.25, llm: 0.25, fallback: 0.25 });
  assert.deepEqual(s.jevLatency, { samples: 3, p50: 30, p95: 50 });
  assert.equal(s.cost.total, 0.007);
  assert.equal(s.costPer1000, 1.75);
  const report = renderReport(rows, "synthetic-test");
  assert.match(report, /75\.0%/);
  assert.match(report, /\| rule \| allow \| allow \| rule \| — \| — \|/);
  assert.match(report, /\| llm \| ask \| allow \| llm \| 30 \| 80 \|/);
  assert.match(report, /\$0\.007000/);
  assert.match(report, /\$1\.750000/);
});

test("handles rule-only reports without inventing Jev latency", () => {
  const rows = [{ test: fixture("rule"), result: result("allow", "rule") }];
  assert.deepEqual(summarize(rows).jevLatency, { samples: 0, p50: null, p95: null });
  assert.match(renderReport(rows), /N\/A/);
  assert.equal(summarize([]).accuracy, 0);
  assert.equal(summarize([]).costPer1000, 0);
});
