const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
]);

function readTranscript(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== trimmed) return readTranscript(parsed, depth + 1) || trimmed;
    } catch {
      // Plain-text webhook responses are valid transcripts too.
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const transcript = readTranscript(item, depth + 1);
      if (transcript) return transcript;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["transcript", "text", "output", "result", "data", "message", "content"]) {
    const transcript = readTranscript(record[key], depth + 1);
    if (transcript) return transcript;
  }
  return "";
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
    outgoing.append("language", "auto");

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

    const responseText = await response.text();
    let body: unknown = responseText;
    try { body = JSON.parse(responseText) as unknown; } catch { /* Plain text is supported. */ }
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
