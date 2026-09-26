import type { JsonValue } from "@typesafe-ai/sdk";
import { applyRules, isInsideProject, touchesSecrets } from "./rules.js";
import { INJECTION_QUESTION, getJev, jevCost, ON_TASK_QUESTION, RISK_QUESTIONS, RISK_SIGNALS, type RiskSignal } from "./jev.js";
import { systemTwo } from "./llm.js";
import type { Decision, ToolCall } from "./types.js";

/** Thresholds live in code so they can be tuned per team without touching a prompt. */
export const THRESHOLDS = {
  deny: 0.85, // one high-stakes signal above this is denied outright
  ask: 0.6, // any risk signal above this needs a human
  gray: 0.3, // between gray and ask, System Two decides
  onTask: 0.75, // normalized on_task at or above this counts as clearly on task
  offTask: 0.35, // below this, outward-facing actions need a human
  taintShift: 0.2, // after untrusted instructions were seen, every threshold drops by this much
  injection: 0.7, // PostToolUse: content above this taints the session
};

const LABELS: Record<RiskSignal, string> = {
  destructive: "Could destroy data that is hard to restore",
  secrets: "Touches secrets or credentials",
  exfiltration: "Sends local data off the machine",
  remote_code: "Downloads and runs remote code",
  tampering: "Changes the agent's own safety settings",
};

const OUTWARD = new Set(["network", "git_remote", "install", "system"]);

export interface CheckInput extends ToolCall {
  goal: string | null;
  tainted: boolean;
}

export interface CheckResult {
  decision: Decision;
  signals: Record<string, number>;
  category?: string;
  latency: { total: number; jev?: number; llm?: number };
  cost: { jev: number; llm: number };
  tokens: { jev_in: number; llm_in: number; llm_out: number };
}

const since = (t: number) => Math.round(performance.now() - t);
const verdict = (v: Decision["verdict"], reason: string): Decision => ({ verdict: v, layer: "jev", reason });

function truncate(value: unknown, max = 2000): JsonValue {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}... [truncated]` : value;
  if (Array.isArray(value)) return value.map((v) => truncate(v, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncate(v, max)]));
  }
  return typeof value === "number" || typeof value === "boolean" ? value : null;
}

/** Small, relevant state only: Jev loses accuracy when the state is padded with unrelated detail. */
function buildState(input: CheckInput) {
  const path = input.tool_input.file_path ?? input.tool_input.notebook_path ?? input.tool_input.path;
  const facts: Record<string, JsonValue> = {};
  if (typeof path === "string") facts.path_is_inside_project = isInsideProject(path, input.cwd);
  if (touchesSecrets(input)) facts.mentions_sensitive_path = true;
  return {
    ...(input.goal ? { user_goal: input.goal } : {}),
    tool_call: { tool: input.tool_name, input: truncate(input.tool_input) },
    ...(Object.keys(facts).length ? { facts_computed_by_code: facts } : {}),
  };
}

export function decide(s: Record<string, number>, category: string | undefined, tainted: boolean): Decision | "escalate" {
  const shift = tainted ? THRESHOLDS.taintShift : 0;
  const deny = THRESHOLDS.deny - shift;
  const ask = THRESHOLDS.ask - shift;
  const gray = THRESHOLDS.gray - shift;
  const onTask = s.on_task as number | undefined;

  if (s.secrets >= 0.5 && s.exfiltration >= 0.5) return verdict("deny", "Reads secrets and sends data off the machine");
  if (s.remote_code >= deny) return verdict("deny", LABELS.remote_code);
  if (s.tampering >= deny) return verdict("deny", LABELS.tampering);
  if (s.destructive >= deny && onTask !== undefined && onTask < THRESHOLDS.onTask) {
    return verdict("deny", "Destructive and not part of what you asked for");
  }

  const [top, p] = RISK_SIGNALS.map((k) => [k, s[k] ?? 0] as const).reduce((a, b) => (b[1] > a[1] ? b : a));
  const clearlyOnTask = onTask !== undefined && onTask >= THRESHOLDS.onTask;
  const offTaskOutward = onTask !== undefined && onTask < THRESHOLDS.offTask && category !== undefined && OUTWARD.has(category);
  if (p >= ask) {
    // "Delete the build folder" is destructive but requested: let System Two weigh it instead of nagging.
    if (clearlyOnTask && top === "destructive") return "escalate";
    // Risky, outward-facing and unrelated to the request is the signature of a hijacked agent.
    if (offTaskOutward) return verdict("deny", `${LABELS[top]}, outward-facing, and unrelated to your request`);
    return verdict("ask", `${LABELS[top]} (p=${p.toFixed(2)})`);
  }
  if (offTaskOutward) return verdict("ask", "Outward-facing action that looks unrelated to your request");
  if (p >= gray) return "escalate";
  if (tainted && category && OUTWARD.has(category)) return "escalate";
  return verdict("allow", "No risk signals");
}

export async function check(input: CheckInput): Promise<CheckResult> {
  const t0 = performance.now();
  const empty = { jev_in: 0, llm_in: 0, llm_out: 0 };

  const ruled = applyRules(input);
  if (ruled) {
    return { decision: ruled, signals: {}, latency: { total: since(t0) }, cost: { jev: 0, llm: 0 }, tokens: empty };
  }

  const questions = { ...RISK_QUESTIONS, ...(input.goal ? { on_task: ON_TASK_QUESTION } : {}) };
  const tJev = performance.now();
  let answers: Record<string, any>;
  let jevTokens = 0;
  try {
    const res = await getJev().systemOne({ state: buildState(input), questions }, { retry: { maxRetries: 1 } });
    answers = res.answers;
    jevTokens = res.usage.input_tokens;
  } catch (err) {
    return {
      decision: { verdict: "ask", layer: "fallback", reason: `Jev unavailable (${(err as Error).message}); asking to be safe` },
      signals: {},
      latency: { total: since(t0), jev: since(tJev) },
      cost: { jev: 0, llm: 0 },
      tokens: empty,
    };
  }
  const jevMs = since(tJev);

  const signals: Record<string, number> = {};
  for (const k of RISK_SIGNALS) signals[k] = answers[k].noul;
  if (answers.on_task) signals.on_task = answers.on_task.score / 2;
  const category: string = answers.category.choice;
  signals.category_confidence = answers.category.confidence;

  const first = decide(signals, category, input.tainted);
  const result: CheckResult = {
    decision: first === "escalate" ? { verdict: "ask", layer: "fallback", reason: "" } : first,
    signals,
    category,
    latency: { total: 0, jev: jevMs },
    cost: { jev: jevCost(jevTokens), llm: 0 },
    tokens: { jev_in: jevTokens, llm_in: 0, llm_out: 0 },
  };

  if (first === "escalate") {
    const tLlm = performance.now();
    const s2 = await systemTwo({
      user_goal: input.goal ?? "(unknown)",
      tool_call: { tool: input.tool_name, input: truncate(input.tool_input, 4000) },
      session_saw_untrusted_instructions: input.tainted,
      classifier_signals: signals,
      classifier_category: category,
    });
    result.latency.llm = since(tLlm);
    if (s2) {
      result.decision = { verdict: s2.verdict, layer: "llm", reason: s2.reason };
      result.cost.llm = s2.costUsd;
      result.tokens.llm_in = s2.inTokens;
      result.tokens.llm_out = s2.outTokens;
    } else {
      result.decision = { verdict: "ask", layer: "fallback", reason: "Unclear risk and System Two did not answer; asking to be safe" };
    }
  }

  result.latency.total = since(t0);
  return result;
}

export interface ScanResult {
  injection: number;
  latencyMs: number;
  tokens: number;
  cost: number;
}

/** PostToolUse: does content the agent just read try to instruct the agent? */
export async function scanContent(content: string): Promise<ScanResult | null> {
  const t0 = performance.now();
  try {
    const res = await getJev().systemOne(
      { state: { content: content.slice(0, 12000) }, questions: { injection: INJECTION_QUESTION } },
      { retry: { maxRetries: 1 } },
    );
    return {
      injection: res.answers.injection.noul,
      latencyMs: since(t0),
      tokens: res.usage.input_tokens,
      cost: jevCost(res.usage.input_tokens),
    };
  } catch (err) {
    console.error("[flinch] content scan failed:", (err as Error).message);
    return null;
  }
}
