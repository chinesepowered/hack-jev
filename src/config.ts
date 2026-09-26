import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

export const config = {
  port: Number(process.env.FLINCH_PORT ?? 7777),
  jevModel: process.env.FLINCH_JEV_MODEL ?? "jev-latest",
  /** Jev bills input tokens only: $0.042 per million. */
  jevUsdPerMTok: 0.042,
  llm: {
    // Any OpenAI-compatible endpoint. Default is GMI Cloud.
    baseURL: process.env.LLM_BASE_URL ?? "https://api.gmi-serving.com/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "zai-org/GLM-5.3-Flash",
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 12000),
    // Only used for the cost panel. Set these to your model's real prices.
    usdPerMTokIn: Number(process.env.LLM_USD_PER_MTOK_IN ?? 0.3),
    usdPerMTokOut: Number(process.env.LLM_USD_PER_MTOK_OUT ?? 1.2),
  },
  /**
   * "defer": safe calls fall through to Claude Code's normal permission flow.
   * "allow": Flinch explicitly approves safe calls, replacing blanket auto-approve.
   */
  allowMode: (process.env.FLINCH_ALLOW_MODE ?? "defer") as "allow" | "defer",
};
