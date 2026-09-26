export type Verdict = "allow" | "ask" | "deny";

/** Which layer of the cascade made the call. */
export type Layer = "rule" | "jev" | "llm" | "fallback";

export interface ToolCall {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
}

export interface Decision {
  verdict: Verdict;
  layer: Layer;
  reason: string;
}

/**
 * One row in the dashboard feed and in data/events.jsonl.
 * The dashboard depends on this shape, so extend it rather than changing fields.
 */
export interface FlinchEvent {
  id: string;
  ts: string;
  kind: "check" | "observe";
  source: "hook" | "simulate" | "eval";
  session_id: string;
  tool_name: string;
  summary: string;
  goal: string | null;
  /** "tainted" / "clean" are used by observe events (PostToolUse content scans). */
  verdict: Verdict | "tainted" | "clean";
  layer: Layer;
  reason: string;
  /** Jev probabilities, 0..1. on_task is the Score normalized to 0..1. */
  signals: Record<string, number>;
  category?: string;
  tainted: boolean;
  latency_ms: { total: number; jev?: number; llm?: number };
  cost_usd: { jev: number; llm: number };
  tokens: { jev_in: number; llm_in: number; llm_out: number };
}
