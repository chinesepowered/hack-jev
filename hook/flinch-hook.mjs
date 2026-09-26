#!/usr/bin/env node
// Claude Code hook for UserPromptSubmit, PreToolUse and PostToolUse.
// Forwards the event to the local Flinch server and prints its decision. No dependencies, so startup stays fast.
const port = process.env.FLINCH_PORT || 7777;
// What PreToolUse does when the server is unreachable: "ask" (default), "deny", or "allow".
const failMode = process.env.FLINCH_FAIL_MODE || "ask";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let event = {};
try {
  event = JSON.parse(raw);
} catch {}

try {
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
    signal: AbortSignal.timeout(25000),
  });
  const out = await res.text();
  if (res.ok && out && out !== "{}") process.stdout.write(out);
} catch (err) {
  if (event.hook_event_name === "PreToolUse" && failMode !== "allow") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: failMode,
          permissionDecisionReason: `Flinch server unreachable on port ${port} (${err.message}); failing closed.`,
        },
      }),
    );
  }
}
