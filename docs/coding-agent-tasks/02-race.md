# Task 02: "Jev vs LLM" race

Add a race that shows, side by side, why Flinch uses a System One model: the same batch of tool calls is judged by (A) the Flinch pipeline (rules, then Jev, then an LLM only when unsure) and (B) an LLM judge on every call. Read `docs/API.md`, `src/policy.ts` (`check`) and `src/llm.ts` (`systemTwo`) first. Do not edit `public/index.html` (another task owns it).

## Backend

1. `fixtures/race-cases.json`: 24 realistic cases, each `{ "goal", "tool_name", "tool_input", "expected": "allow" | "ask" | "deny" }`. Mix: 10 routine (tests, reads, edits, installs that match the goal), 6 risky-but-requested (e.g. delete build output when asked), 8 clearly bad (off-task force push, reading SSH keys, piping remote scripts to sh, uploading `.env`, editing agent settings, `rm -rf ~`). Use only placeholder hosts like `example.invalid` and fake paths; nothing in the fixtures may be a real endpoint.
2. `src/race.ts` exporting `runRace(cases, emit)`:
   - Lane `flinch`: `check({ ...case, session_id: "race", goal, tainted: false })`.
   - Lane `llm`: `systemTwo({ user_goal, tool_call, classifier_signals: {} })` for every case (no Jev, no rules). Treat a `null` result as verdict `ask`.
   - Run both lanes at the same time, each with a concurrency limit of 6.
   - After each case: `emit({ lane, index, verdict, expected, correct, latency_ms, cost_usd })`. `cost_usd` for the flinch lane is `cost.jev + cost.llm`; for the llm lane use `costUsd`.
   - When a lane finishes: `emit({ lane, done: true, elapsed_ms, total_cost_usd, correct, total })`.
3. In `src/server.ts` add:
   - `GET /api/race`: a server-sent-events stream that runs one race and writes each emitted object as `data: <json>\n\n`, then `data: {"finished":true}` and ends. Reject a second race while one is running (HTTP 409).
   - `GET /race`: serves `public/race.html`.
   Keep the existing routes untouched.

## Frontend: `public/race.html`

Single self-contained file (vanilla JS + inline CSS, no external scripts), dark projector-friendly style matching a dark dashboard: green allow, amber ask, red deny, blue for Jev, purple for LLM.

- Header "Jev vs LLM: judging 24 agent actions" with a big "Start race" button and a link back to `/`.
- Two lanes stacked: "Flinch: rules + Jev, LLM only when unsure" and "LLM judge on every call (GLM on GMI Cloud)".
- Each lane: a progress bar, a live elapsed-time counter (updates every 50ms until the lane is done), a live cost counter in USD (6 decimals), and a grid of 24 case cells that fill with the verdict color as results arrive, with a check or cross for match vs expected. Hovering a cell shows the tool call, verdict, expected and latency.
- When both lanes finish, a summary strip: "Flinch finished in X s for $Y (Z/24 correct); LLM-only took A s for $B (C/24 correct). Flinch was N x faster and M x cheaper."
- Uses `new EventSource("/api/race")`; close it on `{"finished":true}`.

## Acceptance

- `pnpm typecheck` passes.
- No console errors; the page handles a 409 by showing "race already running".
- Deliver as a pull request.
