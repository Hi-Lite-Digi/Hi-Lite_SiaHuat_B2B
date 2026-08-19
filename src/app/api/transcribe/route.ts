const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
]);

function readTranscript(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const transcript = record.transcript ?? record.text;
  return typeof transcript === "string" ? transcript.trim() : "";
}

export async function POST(request: Request) {
  const webhookUrl = process.env.N8N_VOICE_WEBHOOK_URL;
  const workflowKey = process.env.N8N_WORKFLOW_KEY;

  if (!webhookUrl || !workflowKey) {
    console.error("[api/transcribe] voice workflow is not configured");
    return Response.json({ error: "VOICE_TRANSCRIPTION_NOT_CONFIGURED" }, { status: 503 });
  }

  try {
    const incoming = await request.formData();
    const audio = incoming.get("audio");
    const sessionId = String(incoming.get("sessionId") ?? "").slice(0, 100);

    if (!(audio instanceof File) || audio.size === 0) {
      return Response.json({ error: "AUDIO_REQUIRED" }, { status: 400 });
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      return Response.json({ error: "AUDIO_TOO_LARGE" }, { status: 413 });
    }

    const normalizedType = audio.type.split(";")[0].toLowerCase();
    if (!ALLOWED_AUDIO_TYPES.has(normalizedType)) {
      return Response.json({ error: "AUDIO_TYPE_NOT_SUPPORTED" }, { status: 415 });
    }

    const outgoing = new FormData();
    outgoing.append("data", audio, audio.name || "voice-note.webm");
    outgoing.append("sessionId", sessionId);

    console.log("[api/transcribe] sending voice note to n8n", {
      bytes: audio.size,
      contentType: normalizedType,
      sessionId,
    });

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "x-workflow-key": workflowKey },
      body: outgoing,
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      console.error("[api/transcribe] n8n rejected voice note", { status: response.status });
      return Response.json({ error: "VOICE_TRANSCRIPTION_FAILED" }, { status: 502 });
    }

    const transcript = readTranscript(body);
    if (!transcript) {
      console.error("[api/transcribe] n8n returned an empty transcript");
      return Response.json({ error: "VOICE_TRANSCRIPT_EMPTY" }, { status: 422 });
    }

    console.log("[api/transcribe] transcription complete", { characters: transcript.length });
    return Response.json({ transcript });
  } catch (error) {
    console.error("[api/transcribe] failed", error);
    return Response.json({ error: "VOICE_TRANSCRIPTION_FAILED" }, { status: 502 });
  }
}
