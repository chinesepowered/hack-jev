import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let state;
const signals = ['destructive', 'secrets', 'exfiltration', 'remote_code', 'tampering'];
mock.module('../src/jev.ts', { namedExports: {
  jev: { systemOne: async (request) => {
    state = request.state;
    return { answers: { ...Object.fromEntries(signals.map((key) => [key, { noul: 0 }])),
      category: { choice: 'edit_project', confidence: 1 }, on_task: { score: 2 } }, usage: { input_tokens: 100 } };
  } },
  jevCost: () => 0, RISK_SIGNALS: signals, RISK_QUESTIONS: {}, ON_TASK_QUESTION: {}, INJECTION_QUESTION: {},
} });
mock.module('../src/llm.ts', { namedExports: { systemTwo: async () => null } });
const { check } = await import('../src/policy.ts');

test('Jev state retains JSON values and truncates nested strings at the API boundary', async () => {
  const checked = await check({ session_id: 'race', goal: 'Edit the demo file', tainted: false,
    tool_name: 'Edit', tool_input: { file_path: 'demo-project/file.json',
      content: { nested: ['x'.repeat(2001), 42, true, null], object: { short: 'value' } } } });
  assert.equal(checked.decision.verdict, 'allow');
  assert.deepEqual(state, { user_goal: 'Edit the demo file',
    tool_call: { tool: 'Edit', input: { file_path: 'demo-project/file.json',
      content: { nested: ['x'.repeat(2000) + '... [truncated]', 42, true, null], object: { short: 'value' } } } },
    facts_computed_by_code: { path_is_inside_project: true } });
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});
