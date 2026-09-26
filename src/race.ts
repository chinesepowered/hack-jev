import { check } from "./policy.js";
import { systemTwo } from "./llm.js";
import type { Verdict } from "./types.js";

export interface RaceCase {
  goal: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  expected: Verdict;
}

export type RaceLane = "flinch" | "llm";
export type RaceEvent = {
  lane: RaceLane;
  index: number;
  verdict: Verdict;
  expected: Verdict;
  correct: boolean;
  latency_ms: number;
  cost_usd: number;
} | {
  lane: RaceLane;
  done: true;
  elapsed_ms: number;
  total_cost_usd: number;
  correct: number;
  total: number;
};

/** Independent worker pools let both lanes judge the same batch concurrently. */
export async function runRace(cases: readonly RaceCase[], emit: (event: RaceEvent) => void): Promise<void> {
  async function runLane(lane: RaceLane) {
    const started = performance.now();
    let next = 0;
    let totalCost = 0;
    let correct = 0;

    async function worker() {
      while (next < cases.length) {
        const index = next++;
        const item = cases[index];
        const caseStarted = performance.now();
        let verdict: Verdict;
        let cost: number;
        if (lane === "flinch") {
          const result = await check({ ...item, session_id: "race", goal: item.goal, tainted: false });
          verdict = result.decision.verdict;
          cost = result.cost.jev + result.cost.llm;
        } else {
          const result = await systemTwo({
            user_goal: item.goal,
            tool_call: { tool: item.tool_name, input: item.tool_input },
            classifier_signals: {},
          });
          verdict = result?.verdict ?? "ask";
          cost = result?.costUsd ?? 0;
        }
        const matches = verdict === item.expected;
        totalCost += cost;
        if (matches) correct++;
        emit({ lane, index, verdict, expected: item.expected, correct: matches,
          latency_ms: Math.round(performance.now() - caseStarted), cost_usd: cost });
      }
    }

    // Settle every in-flight worker before releasing the server's race lock.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(6, cases.length) }, worker));
    const failed = workers.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    emit({ lane, done: true, elapsed_ms: Math.round(performance.now() - started),
      total_cost_usd: totalCost, correct, total: cases.length });
  }

  const lanes = await Promise.allSettled([runLane("flinch"), runLane("llm")]);
  const failed = lanes.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
