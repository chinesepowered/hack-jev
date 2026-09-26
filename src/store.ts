import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FlinchEvent } from "./types.js";

const dataDir = resolve(import.meta.dirname, "../data");
mkdirSync(dataDir, { recursive: true });
const logPath = join(dataDir, "events.jsonl");
const MAX_EVENTS = 1000;

interface Session {
  prompts: string[];
  tainted: boolean;
  taintSource?: string;
}

const sessions = new Map<string, Session>();

export function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { prompts: [], tainted: false };
    sessions.set(id, s);
  }
  return s;
}

export function recordPrompt(id: string, prompt: string) {
  const s = getSession(id);
  s.prompts.push(prompt.slice(0, 2000));
  if (s.prompts.length > 3) s.prompts.shift();
}

/** The latest request plus a little history, so "yes, do it" still has context. */
export function goalFor(id: string): string | null {
  const prompts = sessions.get(id)?.prompts ?? [];
  if (!prompts.length) return null;
  const latest = prompts[prompts.length - 1];
  const earlier = prompts.slice(0, -1);
  return earlier.length ? `Latest request: ${latest}\nEarlier requests: ${earlier.join(" | ")}` : latest;
}

export function taint(id: string, source: string) {
  const s = getSession(id);
  s.tainted = true;
  s.taintSource = source;
}

const events: FlinchEvent[] = existsSync(logPath)
  ? readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-MAX_EVENTS)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as FlinchEvent];
        } catch {
          return [];
        }
      })
  : [];

type Listener = (e: FlinchEvent) => void;
const listeners = new Set<Listener>();

export function publish(e: FlinchEvent) {
  events.push(e);
  if (events.length > MAX_EVENTS) events.shift();
  appendFileSync(logPath, `${JSON.stringify(e)}\n`);
  for (const l of listeners) l(e);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function recentEvents(limit = 200): FlinchEvent[] {
  return events.slice(-limit);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function stats() {
  const checks = events.filter((e) => e.kind === "check");
  const count = (pred: (e: FlinchEvent) => boolean) => checks.filter(pred).length;
  const jevLatencies = events.map((e) => e.latency_ms.jev).filter((v): v is number => typeof v === "number");
  const jevCost = events.reduce((sum, e) => sum + e.cost_usd.jev, 0);
  const llmCost = events.reduce((sum, e) => sum + e.cost_usd.llm, 0);
  return {
    checks: checks.length,
    verdicts: { allow: count((e) => e.verdict === "allow"), ask: count((e) => e.verdict === "ask"), deny: count((e) => e.verdict === "deny") },
    layers: {
      rule: count((e) => e.layer === "rule"),
      jev: count((e) => e.layer === "jev"),
      llm: count((e) => e.layer === "llm"),
      fallback: count((e) => e.layer === "fallback"),
    },
    scans: events.filter((e) => e.kind === "observe").length,
    tainted_sessions: [...sessions.values()].filter((s) => s.tainted).length,
    jev_latency_ms: { p50: percentile(jevLatencies, 50), p95: percentile(jevLatencies, 95) },
    cost_usd: { jev: jevCost, llm: llmCost, total: jevCost + llmCost },
  };
}
