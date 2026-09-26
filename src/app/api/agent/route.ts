// src/app/api/agent/route.ts
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { agentRequestSchema } from "@/lib/agent/contract";
import { defaultFactDeps } from "@/lib/agent/facts";
import { runAgentTurn, type AgentClient } from "@/lib/agent/loop";
import { inSessionOrder } from "@/lib/agent/session-queue";
import { claudeModel } from "@/lib/claude-client";
import { withModelUsage } from "@/lib/model-usage";

export const runtime = "nodejs";
export const maxDuration = 60;
// The whole turn's share of maxDuration (Claude, tools and the backup reply),
// counted from arrival so time queued behind the same session is included.
const TURN_BUDGET_MS = 45_000;

export async function POST(request: Request) {
  const arrived = performance.now();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }
  const input = agentRequestSchema.safeParse(body);
  if (!input.success) return NextResponse.json({ error: "Please send a valid message." }, { status: 400 });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "The conversational assistant is not configured yet." }, { status: 503 });

  const model = claudeModel();
  const anthropic = new Anthropic({ apiKey, timeout: 18_000, maxRetries: 1 });
  // A customer who leaves also stops the Claude calls, so the session queue is not held for nobody.
  const client: AgentClient = {
    messages: {
      create: (params, options) => anthropic.messages.create(params, {
        ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, request.signal]) : request.signal,
      }),
    },
  };

  return inSessionOrder(input.data.sessionId, () => withModelUsage(async () => {
    const deadlineMs = Math.max(1, Math.ceil(TURN_BUDGET_MS - (performance.now() - arrived)));
    const reply = await runAgentTurn({ request: input.data, deps: defaultFactDeps(), client, model, deadlineMs });
    return NextResponse.json(reply, { headers: { "x-chat-provider": reply.provider, "x-chat-model": model } });
  }));
}
