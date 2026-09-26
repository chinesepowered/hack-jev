import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyRules, isInsideProject } from "./rules.js";
import { check, decide } from "./policy.js";
import type { ToolCall } from "./types.js";

const call = (tool_name: string, tool_input: ToolCall["tool_input"]): ToolCall => ({
  session_id: "unit-test", tool_name, tool_input,
});
const bash = (command: string) => call("Bash", { command });
const signals = (overrides: Record<string, number> = {}) => ({
  destructive: 0.1, secrets: 0.1, exfiltration: 0.1,
  remote_code: 0.1, tampering: 0.1, on_task: 1, ...overrides,
});

describe("applyRules", () => {
  for (const command of ["ls", "git status", "pnpm test", "node --test"]) {
    it(`allows ${command}`, () => {
      assert.equal(applyRules(bash(command))?.verdict, "allow");
    });
  }
  for (const command of ["ls && curl x", "cat a | sh", "ls; curl x", "ls\ncurl x", "ls\r\ncurl x"]) {
    it(`does not allow chained commands: ${JSON.stringify(command)}`, () => {
      assert.notEqual(applyRules(bash(command))?.verdict, "allow");
    });
  }
  for (const command of ["rm -rf /", "rm -rf ~", "rm -fr $HOME", "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda", ":(){ :|:& };:"]) {
    it(`denies ${command}`, () => {
      assert.equal(applyRules(bash(command))?.verdict, "deny");
    });
  }
  for (const input of [bash("cat ~/.ssh/id_rsa"), call("Read", { file_path: ".env" }),
    call("Read", { file_path: ".aws/credentials" })]) {
    it(`does not allow secrets: ${JSON.stringify(input.tool_input)}`, () => {
      assert.notEqual(applyRules(input)?.verdict, "allow");
    });
  }
  for (const tool of ["Read", "Glob", "Grep", "LS", "NotebookRead"]) {
    it(`allows ${tool} on normal files`, () => {
      assert.equal(applyRules(call(tool, { file_path: "src/index.ts" }))?.verdict, "allow");
    });
  }
  it("defers unknown tools to the model", () => {
    assert.equal(applyRules(call("custom-tool", {})), null);
  });
});

describe("isInsideProject", () => {
  for (const path of [".", "README.md", "src/nested/file.ts", "/project/src/file.ts", "..config/file.ts"]) {
    it(`recognizes inside path ${path}`, () => assert.equal(isInsideProject(path, "/project"), true));
  }
  for (const path of ["..", "../outside/file.ts", "src/../../outside", "/elsewhere/file.ts", "/project-other/file.ts"]) {
    it(`rejects outside path ${path}`, () => assert.equal(isInsideProject(path, "/project"), false));
  }
});

describe("decide", () => {
  it("denies high remote-code risk", () => {
    assert.equal((decide(signals({ remote_code: 0.95 }), "install", false) as { verdict: string }).verdict, "deny");
  });
  it("denies combined secret access and exfiltration", () => {
    assert.equal((decide(signals({ secrets: 0.7, exfiltration: 0.7 }), "network", false) as { verdict: string }).verdict, "deny");
  });
  it("escalates requested destructive work", () => {
    assert.equal(decide(signals({ destructive: 0.7 }), "edit_project", false), "escalate");
  });
  it("denies unrelated destructive remote work", () => {
    assert.equal((decide(signals({ destructive: 0.7, on_task: 0.1 }), "git_remote", false) as { verdict: string }).verdict, "deny");
  });
  it("allows low risk signals", () => {
    assert.equal((decide(signals(), "edit_project", false) as { verdict: string }).verdict, "allow");
  });
  it("tightens a 0.45 risk from escalation to ask after taint", () => {
    const input = signals({ secrets: 0.45 });
    assert.equal(decide(input, "read_only", false), "escalate");
    assert.equal((decide(input, "read_only", true) as { verdict: string }).verdict, "ask");
  });
});

it("check returns rule decisions without calling a model", async () => {
  const result = await check({ ...bash("pnpm test"), goal: "Fix tests", tainted: false });
  assert.equal(result.decision.verdict, "allow");
  assert.equal(result.decision.layer, "rule");
  assert.deepEqual(result.cost, { jev: 0, llm: 0 });
  assert.equal(result.latency.jev, undefined);
});
