import fs from "node:fs/promises";
import path from "node:path";
import type {
  ChatReply,
  ChatRequest,
  HistoryItem,
  ImageAttachment,
} from "../src/lib/chat-contract";

export const qaBaseUrl = process.env.QA_BASE_URL ?? "http://localhost:3001";

type ChatOptions = {
  message: string;
  history?: HistoryItem[];
  image?: ImageAttachment;
  sessionId?: string;
};

export async function postChat({
  message,
  history = [],
  image,
  sessionId = `qa-${crypto.randomUUID()}`,
}: ChatOptions) {
  const request: ChatRequest = { sessionId, message, history, image };
  const started = performance.now();
  const response = await fetch(`${qaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json() as ChatReply & { error?: string };

  return {
    status: response.status,
    body,
    durationMs: Math.round(performance.now() - started),
  };
}

export async function writeQaReport(name: string, report: unknown) {
  const outputDir = path.resolve("tmp", "qa-reports");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, name);
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outputPath;
}
