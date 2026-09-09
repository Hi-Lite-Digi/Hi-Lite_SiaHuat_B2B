import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export type ResponsesUsage = {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

type UsageRecord = {
  model: string;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimatedUsd: number | null;
};
type UsageScope = { attempts: number; records: UsageRecord[] };
const usageScope = new AsyncLocalStorage<UsageScope>();
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Standard USD rates checked 2026-09-10. Output includes reasoning: do not count it twice. */
export function calculateModelUsage(model: string, usage?: ResponsesUsage): UsageRecord | null {
  if (!usage || !count(usage.input_tokens) || !count(usage.output_tokens)) return null;
  const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens ?? 0;
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? 0;
  if (![cachedTokens, cacheWriteTokens, reasoningTokens].every(count)
    || cachedTokens + cacheWriteTokens > usage.input_tokens || reasoningTokens > usage.output_tokens) return null;
  const longContext = usage.input_tokens > 272_000;
  const knownModel = /^gpt-5\.6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
  const estimatedUsd = knownModel ? (
    ((usage.input_tokens - cachedTokens - cacheWriteTokens) * 0.20 + cachedTokens * 0.02 + cacheWriteTokens * 0.25) * (longContext ? 2 : 1)
    + usage.output_tokens * 1.20 * (longContext ? 1.5 : 1)
  ) / 1_000_000 : null;
  return { model, inputTokens: usage.input_tokens, cachedTokens, cacheWriteTokens,
    outputTokens: usage.output_tokens, reasoningTokens, estimatedUsd };
}

/** Capture the scope now so late responses cannot be attributed to a different customer. */
export function beginModelCall() {
  const scope = usageScope.getStore();
  if (scope) scope.attempts += 1;
  let recorded = false;
  return (record: UsageRecord | null) => {
    if (!recorded && record && scope) scope.records.push(record);
    recorded = true;
  };
}

export function recordModelUsage(model: string, usage: ResponsesUsage | undefined, requestId: string | null) {
  const record = calculateModelUsage(model, usage);
  // No customer messages, images, catalogue contents or credentials in usage logs.
  console.info("[ai/usage]", JSON.stringify({ provider: "openai", requestId,
    ...(record ?? { model, usage: "unavailable" }) }));
  return record;
}

export async function withModelUsage(run: () => Promise<Response>): Promise<Response> {
  const scope: UsageScope = { attempts: 0, records: [] };
  return usageScope.run(scope, async () => {
    const response = await run();
    const sum = (field: "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens") => scope.records.reduce((total, record) => total + record[field], 0);
    const cost = scope.records.reduce((total, record) => total + (record.estimatedUsd ?? 0), 0);
    const complete = scope.attempts === scope.records.length && scope.records.every(record => record.estimatedUsd !== null);
    response.headers.set("x-ai-usage", JSON.stringify({ attempts: scope.attempts, measuredCalls: scope.records.length,
      inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cachedTokens: sum("cachedTokens"),
      cacheWriteTokens: sum("cacheWriteTokens"), estimatedUsd: Number(cost.toFixed(9)), complete }));
    return response;
  });
}
