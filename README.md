# Flinch

**A System One reflex for coding agents.**
Flinch checks every tool call a coding agent makes (Claude Code today) before it runs, in about 150 ms.
TypeSafe's Jev answers seven risk questions per call in a single request; only the unclear calls go to an LLM (GLM on GMI Cloud).
Built at JEVATHON with CodeRabbit's Coding Agent, which wrote our dashboard, our Jev-vs-LLM race and our test suite.

## The problem

- Developers run coding agents on auto-approve, because approving hundreds of tool calls per session by hand is exhausting.
- That makes one poisoned README, issue or web page enough to get the agent to pipe a remote script to `sh`, read `~/.ssh`, upload `.env`, or force-push over `main`.
- The obvious fix, an LLM judging every tool call, costs seconds and cents per call, hundreds of times per session. So nobody runs one, and the guardrails that do exist are brittle regex allowlists.

## Our solution

Flinch sits in the agent's hook points (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`) and runs every tool call through a cascade that is fast by default and slow only when it matters:

1. **Rules (0 ms):** known-safe commands (`pnpm test`, `git status`) are allowed and catastrophic ones (`rm -rf ~`, `mkfs`) denied without any model call.
2. **Jev (~140 ms):** one request asks seven atomic questions in parallel: five risk probabilities (destructive, secrets, exfiltration, remote code, tampering with the agent's own settings), the action's category, and how clearly the call serves what the user actually asked for.
3. **Policy in code:** thresholds that scale with stakes turn probabilities into allow / ask / deny. Risky, outward-facing and unrelated to the request is denied: that is what a hijacked agent looks like.
4. **System Two, only for the gray zone:** GLM on GMI Cloud weighs the unclear calls, such as `rm -rf dist` when the user asked to clean the build output (allowed: "exactly the stated goal").
5. **Taint tracking:** after every fetch or file read, Jev checks the content for instructions aimed at the agent; if it finds some, every threshold tightens for the rest of the session.

If anything is down, Flinch fails closed to "ask". A live dashboard shows every decision with its probabilities, latency and cost.

**Measured with real keys:** 30/30 on our eval set; 50% of calls settled by rules, 47% by Jev, 3% by the LLM; Jev p50 138 ms, p95 224 ms; about **$0.02 per 1,000 tool calls**. In the Jev-vs-LLM race (two live runs), Flinch judged the same 24 actions in **3.5 s** both times (22/24 correct) while an LLM judging every call took **7.8 s and 14.9 s** (21/24), and both of Flinch's misses were cautious asks, never a bad allow.

## Sponsor usage

| Sponsor | What we used | Role in Flinch | Where to look |
| --- | --- | --- | --- |
| **TypeSafe (Jev)** | System One API via `@typesafe-ai/sdk`: Noul, Choice and Score questions, speculative fan-out | The decision engine for every tool call, plus prompt-injection scanning of fetched content | `src/jev.ts`, `src/policy.ts` |
| **CodeRabbit** | Coding Agent (3 parallel tasks + a follow-up turn), PR summaries, CLI | Wrote the dashboard, the Jev-vs-LLM race, 47 tests and the eval harness; found and fixed a security bypass in our rules | PRs [#2](https://github.com/chinesepowered/hack-jev/pull/2), [#3](https://github.com/chinesepowered/hack-jev/pull/3), [#5](https://github.com/chinesepowered/hack-jev/pull/5), [#6](https://github.com/chinesepowered/hack-jev/pull/6); `docs/coding-agent-tasks/` |
| **GMI Cloud** | Inference API (OpenAI-compatible) with `zai-org/GLM-5.3-Flash` | System Two for the gray zone, and the LLM-only baseline in the race | `src/llm.ts`, `src/race.ts` |

## TypeSafe Jev

Jev is why Flinch can exist: a guard has to sit in the hot path of every tool call, and Jev answers in ~140 ms for about $0.00003 per check.

- **Speculative fan-out.** Each tool call is one request with seven questions evaluated in parallel against the same small state: `destructive`, `secrets`, `exfiltration`, `remote_code` and `tampering` as Nouls, `category` as a Choice over seven action types, and `on_task` as a three-level Score against the user's latest request (`src/jev.ts`).
- **Code keeps control.** Following TypeSafe's guidance, Jev only makes semantic judgments. Path checks ("is this file inside the project?", "does this mention a secret path?") are computed in code and passed in as facts, and thresholds, combinations and the escalation band live in `src/policy.ts`, so tuning is a number change rather than a prompt rewrite.
- **Confidence-gated routing.** Clear probabilities act immediately; the band between 0.3 and 0.6 escalates to System Two. A session that has seen injected instructions shifts every threshold by 0.2.
- **Second use: injection scanning.** On `PostToolUse`, a single Noul asks whether fetched or read content contains instructions aimed at an AI agent; if yes, the session is tainted and the agent is told to treat that content as untrusted data.
- **Numbers.** Jev alone settled 47% of eval calls with p50 138 ms and p95 224 ms. Examples: `curl ... | sh` remote_code 0.99 (deny), writing `.claude/settings.json` tampering 0.95 (deny), `cat ~/.ssh/id_rsa` secrets 0.96 (ask).
- **Known limit.** Jev reads state literally and is not adversarially robust yet (TypeSafe's jaggedness notes), which is why it sits between deterministic rules and an LLM with "ask" as the fallback.

## CodeRabbit

We treated CodeRabbit's Coding Agent as a second engineer working in parallel with us.

- **Spec-driven tasks.** We wrote each piece of work as a spec in [`docs/coding-agent-tasks/`](docs/coding-agent-tasks) against a fixed API contract ([`docs/API.md`](docs/API.md)), then started three Coding Agent tasks at once on `main`, each owning different files so they could not conflict.
- **What it built** (every commit authored by `coderabbitai[bot]`; see `git log --author=coderabbitai`):

  | PR | Built by the Coding Agent |
  | --- | --- |
  | [#2](https://github.com/chinesepowered/hack-jev/pull/2) | The live dashboard: KPIs, one-click presets, verdict card, streaming feed |
  | [#3](https://github.com/chinesepowered/hack-jev/pull/3) | 47 unit tests and the 30-case eval harness, plus three bug fixes its tests exposed |
  | [#5](https://github.com/chinesepowered/hack-jev/pull/5) | The Jev-vs-LLM race: backend, SSE endpoint, 24 cases and the race page |
  | [#6](https://github.com/chinesepowered/hack-jev/pull/6) | A follow-up turn: live hook verdicts in the verdict card and labeled signal bars |

- **It found a real security hole in our code.** Its tests showed that a command containing a newline could match our safe-command allowlist and skip Jev entirely. It fixed that in the same PR, along with a path check that misread folders named `..something` and a startup crash without API keys.
- **Reviews.** CodeRabbit summarized every pull request before merge.
- **CLI and feedback.** We installed CodeRabbit CLI 0.8.1 to try `cr code handoff` and posted 20 pieces of Coding Agent and CLI feedback in CodeRabbit's Discord.

## GMI Cloud

GMI Cloud runs our System Two: the generative model that only sees the calls Jev could not settle.

- **OpenAI-compatible by design.** `src/llm.ts` uses the plain `openai` SDK pointed at `https://api.gmi-serving.com/v1` with `zai-org/GLM-5.3-Flash`, so moving to any other provider is an environment change (`LLM_BASE_URL`, `LLM_MODEL`), not a code change.
- **Tuned for a guard.** `reasoning_effort: "low"` switches off GLM's long thinking, bringing verdicts to about 2.5 s; the model returns strict JSON (`verdict`, one-sentence `reason`), sees Jev's probabilities as context, and is told to treat the tool input as untrusted data. A timeout or bad answer falls back to "ask".
- **Used sparingly.** Only 3% of eval calls reached it, which is the point: the expensive model is reserved for real ambiguity, like `rm -rf dist` when the user asked to clean the build output.
- **Also the baseline.** The race's LLM-only lane sends every call to GLM on GMI, which is how we measured Flinch at 3.5 s versus 7.8 to 14.9 s (two runs) for the same 24 actions.
