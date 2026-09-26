# Flinch server API (contract for UI work)

The server is `src/server.ts`, a plain `node:http` server on `http://127.0.0.1:7777` (`FLINCH_PORT`).
Start it with `pnpm install && pnpm start`. Real verdicts need `TYPESAFE_API_KEY` (and `LLM_API_KEY` for System Two) in `.env`.
Without keys, build UI against `fixtures/sample-events.json`, which holds real events captured from the server.

## Event shape

Every decision is a `FlinchEvent` (see `src/types.ts`, the source of truth). Do not rename fields; add new ones if needed.

```ts
interface FlinchEvent {
  id: string;
  ts: string;                        // ISO timestamp
  kind: "check" | "observe";         // check = PreToolUse decision, observe = PostToolUse content scan
  source: "hook" | "simulate" | "eval";
  session_id: string;
  tool_name: string;                 // Bash, Write, Edit, Read, WebFetch, mcp__...
  summary: string;                   // the command / file path / URL, max 300 chars
  goal: string | null;               // what the user asked the agent to do
  verdict: "allow" | "ask" | "deny" | "tainted" | "clean";
  layer: "rule" | "jev" | "llm" | "fallback";  // which layer decided
  reason: string;
  signals: Record<string, number>;   // 0..1: destructive, secrets, exfiltration, remote_code, tampering,
                                     // on_task (Score normalized), category_confidence, injection (observe only)
  category?: string;                 // read_only | edit_project | build_test | install | network | git_remote | system
  tainted: boolean;                  // session saw untrusted instructions earlier
  latency_ms: { total: number; jev?: number; llm?: number };
  cost_usd: { jev: number; llm: number };
  tokens: { jev_in: number; llm_in: number; llm_out: number };
}
```

Rule-decided events have `signals: {}` and no `jev` latency: they never called a model.

## Endpoints

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/` | | `public/index.html` (the dashboard) |
| GET | `/api/events` | `?limit=200` | `FlinchEvent[]`, oldest first |
| GET | `/api/stream` | | Server-sent events. Each message is `data: <FlinchEvent JSON>`. Comment pings every 15s. |
| GET | `/api/stats` | | see below |
| POST | `/api/simulate` | `{ goal, tool_name, tool_input, tainted?, cwd? }` | the resulting `FlinchEvent` (also broadcast on the stream) |
| POST | `/hook` | Claude Code hook payload | hook JSON output; used by `hook/flinch-hook.mjs` |

`/api/stats`:

```json
{
  "checks": 7,
  "verdicts": { "allow": 3, "ask": 2, "deny": 2 },
  "layers": { "rule": 1, "jev": 5, "llm": 1, "fallback": 0 },
  "scans": 0,
  "tainted_sessions": 0,
  "jev_latency_ms": { "p50": 137, "p95": 229 },
  "cost_usd": { "jev": 0.00012, "llm": 0.0003, "total": 0.00042 }
}
```

Example `tool_input` shapes for `/api/simulate`:

- Bash: `{ "command": "git push --force origin main" }`
- Write: `{ "file_path": ".claude/settings.json", "content": "..." }`
- Edit: `{ "file_path": "README.md", "old_string": "teh", "new_string": "the" }`
- WebFetch: `{ "url": "https://example.com/docs", "prompt": "..." }`

## Policy summary (for UI copy)

1. Rules: known-safe commands are allowed and catastrophic ones denied without any model call.
2. Jev (TypeSafe System One): one call asks 5 yes/no risk questions + a category Choice + an on-task Score, in parallel, ~150ms.
3. Code combines the probabilities with thresholds (`THRESHOLDS` in `src/policy.ts`).
4. Only unclear cases escalate to System Two (an OpenAI-compatible LLM, default GLM on GMI Cloud).
5. PostToolUse scans fetched content for instructions aimed at the agent; if found, the session is "tainted" and all thresholds drop by 0.2.
