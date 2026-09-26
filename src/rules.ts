import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Decision, ToolCall } from "./types.js";

/**
 * Deterministic fast path. Anything a regex can settle never reaches a model:
 * obviously safe calls are allowed, a few catastrophic ones are denied,
 * and everything else returns null so Jev can judge it.
 */

const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "TodoRead", "WebSearch",
  "TaskList", "TaskGet", "ToolSearch", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
]);

export const SECRET_PATH =
  /(^|[\\/\s"'=:@])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|gcloud)([\\/]|$)|(^|[\\/\s"'=:@])\.env(\.[\w-]+)?(\s|$|["'])|id_(rsa|ed25519|ecdsa|dsa)\b|credentials|\.npmrc|\.netrc|\.pypirc|\.git-credentials|secrets?\.(json|ya?ml|toml|env)/i;

const CATASTROPHIC: Array<[RegExp, string]> = [
  [/\brm\s+(-\w*\s+)*-\w*[rR]\w*\s+(-\w+\s+)*(\/|\/\*|~|~\/|~\/\*|\$HOME\/?|\$HOME\/\*)(\s|$)/, "Recursive delete of the root or home directory"],
  [/\bmkfs(\.\w+)?\b/, "Formats a filesystem"],
  [/\bdd\b[^|]*\bof=\/dev\/(sd|nvme|disk|hd)/, "Writes raw bytes to a disk device"],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "Fork bomb"],
  [/\bchmod\s+-R\s+0?777\s+\/(\s|$)/, "Makes the whole filesystem world-writable"],
  [/\bformat\s+[a-z]:/i, "Formats a Windows drive"],
];

const SHELL_META = /[\r\n|;&<>`$(){}\\]/;
const SAFE_COMMANDS: RegExp[] = [
  /^(ls|dir|pwd|echo|head|tail|wc|which|where|whoami|date|tree|file|stat|du|df)(\s|$)/,
  /^cat\s+[\w./-]+$/,
  /^git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame|remote -v|stash list)(\s|$)/,
  /^(pnpm|npm|yarn|bun)\s+(run\s+)?(test|lint|build|typecheck|check|format)(\s|$)/,
  /^(pnpm|npm|yarn|bun|node|python|python3|uv|tsc|deno|go|cargo)\s+(-v|--version|-V)$/,
  /^node\s+--test(\s|$)/,
  /^(pytest|uv run pytest|go test|cargo test|tsc --noEmit)(\s|$)/,
];

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

export function touchesSecrets(call: ToolCall): boolean {
  return stringsIn(call.tool_input).some((s) => SECRET_PATH.test(s));
}

export function isInsideProject(path: string, cwd: string | undefined): boolean {
  if (!cwd) return true;
  const rel = relative(resolve(cwd), resolve(cwd, path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const rule = (verdict: Decision["verdict"], reason: string): Decision => ({ verdict, layer: "rule", reason });

export function applyRules(call: ToolCall): Decision | null {
  const { tool_name: tool, tool_input: input } = call;

  if (tool === "Bash" || tool === "PowerShell") {
    const command = String(input.command ?? "").trim();
    for (const [pattern, reason] of CATASTROPHIC) {
      if (pattern.test(command)) return rule("deny", reason);
    }
    if (touchesSecrets(call)) return null;
    if (!SHELL_META.test(command) && SAFE_COMMANDS.some((p) => p.test(command))) {
      return rule("allow", "Known read-only or build/test command");
    }
    return null;
  }

  if (READ_ONLY_TOOLS.has(tool)) {
    return touchesSecrets(call) ? null : rule("allow", "Read-only tool on non-sensitive paths");
  }

  return null;
}
