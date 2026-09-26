import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CheckInput, CheckResult } from "../src/policy.js";
import type { Layer, Verdict } from "../src/types.js";

export interface EvalCase {
  id: string;
  goal: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  expected: Verdict[];
}
export interface EvalRow {
  test: EvalCase;
  result: CheckResult;
}
const verdicts: Verdict[] = ["allow", "ask", "deny"];
const layers: Layer[] = ["rule", "jev", "llm", "fallback"];

export function parseCases(value: unknown): EvalCase[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Expected a nonempty array of eval cases");
  const ids = new Set<string>();
  for (const row of value) {
    if (!row || typeof row.id !== "string" || !row.id.trim() || ids.has(row.id)
      || typeof row.goal !== "string" || typeof row.tool_name !== "string" || !row.tool_name.trim()
      || !row.tool_input || typeof row.tool_input !== "object" || Array.isArray(row.tool_input)
      || !Array.isArray(row.expected) || row.expected.length === 0
      || row.expected.some((v: unknown) => !verdicts.includes(v as Verdict))
      || new Set(row.expected).size !== row.expected.length) {
      throw new Error("Invalid eval case or duplicate id");
    }
    ids.add(row.id);
  }
  return value as EvalCase[];
}

/** Workers claim each case once and preserve fixture order in the report. */
export async function runCases(
  cases: EvalCase[],
  checker: (input: CheckInput) => Promise<CheckResult>,
): Promise<EvalRow[]> {
  const rows = new Array<EvalRow>(cases.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, cases.length) }, async () => {
    while (next < cases.length) {
      const index = next++;
      const test = cases[index];
      const result = await checker({
        session_id: `eval-${test.id}`, goal: test.goal,
        tool_name: test.tool_name, tool_input: test.tool_input,
        cwd: resolve(import.meta.dirname, ".."), tainted: false,
      });
      rows[index] = { test, result };
    }
  }));
  return rows;
}

function percentile(sorted: number[], p: number): number | null {
  return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
}

export function summarize(rows: EvalRow[]) {
  const counts: Record<Layer, number> = { rule: 0, jev: 0, llm: 0, fallback: 0 };
  // Each acceptable verdict set is one row; never count an ask/deny case twice.
  const confusion: Record<string, Record<Verdict, number>> = {};
  const latencies: number[] = [];
  let correct = 0;
  const cost = { jev: 0, llm: 0, total: 0 };
  for (const { test, result } of rows) {
    const got = result.decision.verdict;
    if (test.expected.includes(got)) correct++;
    const expected = verdicts.filter((v) => test.expected.includes(v)).join(" / ");
    confusion[expected] ??= { allow: 0, ask: 0, deny: 0 };
    confusion[expected][got]++;
    counts[result.decision.layer]++;
    if (result.latency.jev !== undefined) latencies.push(result.latency.jev);
    cost.jev += result.cost.jev;
    cost.llm += result.cost.llm;
  }
  latencies.sort((a, b) => a - b);
  cost.total = cost.jev + cost.llm;
  return {
    total: rows.length, correct, accuracy: rows.length ? correct / rows.length : 0,
    confusion, layers: counts,
    layerShares: Object.fromEntries(layers.map((layer) => [layer, rows.length ? counts[layer] / rows.length : 0])),
    jevLatency: { samples: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    cost, costPer1000: rows.length ? cost.total / rows.length * 1000 : 0,
  };
}

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const dollars = (value: number) => `$${value.toFixed(6)}`;

export function renderReport(rows: EvalRow[], timestamp = new Date().toISOString()): string {
  const s = summarize(rows);
  return [
    "# Flinch evaluation", "", `Run: ${timestamp}`, "",
    "## Cases", "",
    "| id | expected | got | layer | jev ms | llm ms |",
    "| --- | --- | --- | --- | ---: | ---: |",
    ...rows.map(({ test, result: r }) => `| ${cell(test.id)} | ${test.expected.join(" / ")} | ${r.decision.verdict} | ${r.decision.layer} | ${r.latency.jev ?? "—"} | ${r.latency.llm ?? "—"} |`),
    "", "## Summary", "",
    `Accuracy: **${percent(s.accuracy)}** (${s.correct}/${s.total} cases match an acceptable verdict).`,
    "", "### Confusion counts", "",
    "Rows are acceptable verdict sets; columns are actual verdicts. Each case is counted once.", "",
    "| expected | allow | ask | deny |", "| --- | ---: | ---: | ---: |",
    ...Object.entries(s.confusion).map(([expected, counts]) => `| ${expected} | ${counts.allow} | ${counts.ask} | ${counts.deny} |`),
    "", "### Deciding layers", "",
    "| layer | count | share |", "| --- | ---: | ---: |",
    ...layers.map((layer) => `| ${layer} | ${s.layers[layer]} | ${percent(s.layerShares[layer])} |`),
    "",
    `Jev latency: p50 **${s.jevLatency.p50 ?? "N/A"} ms**, p95 **${s.jevLatency.p95 ?? "N/A"} ms** (${s.jevLatency.samples} calls; nearest-rank percentiles, including failed attempts with recorded latency; rule-only calls excluded).`,
    "",
    `Reported cost: Jev **${dollars(s.cost.jev)}**, LLM **${dollars(s.cost.llm)}**, total **${dollars(s.cost.total)}**.`,
    "",
    `Projected cost per 1,000 tool calls: **${dollars(s.costPer1000)}** (same case mix).`,
    "",
    "Costs use the policy's configured token prices and reported usage; failed calls may have unreported charges. Fallback decisions remain in accuracy and layer counts.",
    "",
  ].join("\n");
}

async function main() {
  const cases = parseCases(JSON.parse(await readFile(new URL("../fixtures/eval-cases.json", import.meta.url), "utf8")));
  // Loading policy also loads .env through the repository's configuration module.
  const { check } = await import("../src/policy.js");
  if (!process.env.TYPESAFE_API_KEY || !process.env.LLM_API_KEY) {
    throw new Error("pnpm eval requires TYPESAFE_API_KEY and LLM_API_KEY (environment or .env)");
  }
  const report = renderReport(await runCases(cases, check));
  await writeFile(new URL("../docs/EVAL.md", import.meta.url), report);
  console.log(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error("Evaluation failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
