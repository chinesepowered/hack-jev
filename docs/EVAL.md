# Flinch evaluation

No live evaluation has been recorded yet. Run `pnpm eval` with `TYPESAFE_API_KEY`
and `LLM_API_KEY` set in the environment or `.env` to evaluate the 30 cases in
`fixtures/eval-cases.json`, with at most six concurrent checks.

The command prints per-case verdicts and timing, accuracy against acceptable
verdict sets, confusion counts, deciding-layer shares, Jev p50/p95 latency,
reported cost, and projected cost per 1,000 tool calls. It replaces this file
with the same Markdown report. Costs use the configured provider token prices.

Fixture commands and tool inputs are passed to the policy for classification;
they are never executed. Unit tests verify harness behavior using synthetic
results and require no API keys. They do not measure live model accuracy.
