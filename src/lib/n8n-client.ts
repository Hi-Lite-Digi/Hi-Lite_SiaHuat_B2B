import "server-only";
import { chatReplySchema, type ChatRequest } from "@/lib/chat-contract";

// Leave enough time for the API route to validate and format the response
// without letting a text turn cross the one-minute customer-facing budget.
const TEXT_TIMEOUT_MS = 40_000;
const IMAGE_TIMEOUT_MS = 90_000;
const IMAGE_ATTEMPTS = 2;

async function postWorkflow(
  webhookUrl: string,
  workflowKey: string,
  workflowInput: ChatRequest,
  timeoutMs: number,
) {
  return fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sia-huat-key": workflowKey,
    },
    body: JSON.stringify(workflowInput),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function sendChatToN8n(input: ChatRequest) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  const workflowKey = process.env.N8N_WORKFLOW_KEY;

  if (!webhookUrl || !workflowKey) {
    throw new Error("N8N_NOT_CONFIGURED");
  }

  // Filenames are upload metadata, not visual evidence. Keep them out of the
  // AI workflow so OCR and product recognition are based on pixels only.
  const workflowInput: ChatRequest = input.image
    ? {
        ...input,
        image: {
          ...input.image,
          name: "customer-upload",
        },
      }
    : input;

  const attempts = input.image ? IMAGE_ATTEMPTS : 1;
  const timeoutMs = input.image ? IMAGE_TIMEOUT_MS : TEXT_TIMEOUT_MS;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const attemptInput =
        input.image && attempt > 1
          ? {
              ...workflowInput,
              message: `${workflowInput.message} Please search the catalogue now and return grounded possible matches. Do not ask another generic intended-use question.`,
            }
          : workflowInput;
      const response = await postWorkflow(webhookUrl, workflowKey, attemptInput, timeoutMs);

      if (!response.ok) {
        throw new Error(`N8N_HTTP_${response.status}: ${await response.text()}`);
      }

      const reply = chatReplySchema.safeParse(await response.json());
      if (!reply.success) {
        throw new Error(`N8N_INVALID_REPLY: ${JSON.stringify(reply.error.flatten())}`);
      }

      const hasGroundedImageMatch =
        !input.image || reply.data.products.length > 0 || Boolean(reply.data.selectedProduct);
      if (hasGroundedImageMatch || attempt === attempts) {
        return reply.data;
      }

      console.warn("n8n image reply had no catalogue matches; retrying once", { attempt });
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      console.warn("n8n image request failed; retrying once", { attempt, timeoutMs });
    }
  }

  throw lastError ?? new Error("N8N_NO_RESPONSE");
}
