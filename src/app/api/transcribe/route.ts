export const runtime = "nodejs";
export const maxDuration = 60;

// Leave room for multipart overhead within Vercel's request-body limit.
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set(["audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav"]);

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return Response.json({ error: "VOICE_TRANSCRIPTION_NOT_CONFIGURED" }, { status: 503 });
  try {
    const incoming = await request.formData();
    const audio = incoming.get("audio");
    if (!(audio instanceof File) || audio.size === 0) return Response.json({ error: "AUDIO_REQUIRED" }, { status: 400 });
    if (audio.size > MAX_AUDIO_BYTES) return Response.json({ error: "AUDIO_TOO_LARGE" }, { status: 413 });
    const contentType = audio.type.split(";")[0].toLowerCase();
    if (!ALLOWED_AUDIO_TYPES.has(contentType)) return Response.json({ error: "AUDIO_TYPE_NOT_SUPPORTED" }, { status: 415 });

    const model = process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "gpt-transcribe";
    const form = new FormData();
    form.set("model", model);
    form.set("file", audio);
    // Leave language detection to the model so mixed-language notes are preserved.
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      cache: "no-store",
    });
    if (!response.ok) {
      console.error("[api/transcribe] OpenAI request failed", { status: response.status, requestId: response.headers.get("x-request-id") });
      return Response.json({ error: "VOICE_TRANSCRIPTION_FAILED" }, { status: 502 });
    }
    const result = await response.json() as { text?: unknown } | null;
    const transcript = typeof result?.text === "string" ? result.text.trim() : "";
    if (!transcript) return Response.json({ error: "VOICE_TRANSCRIPT_EMPTY" }, { status: 422 });
    return Response.json({ transcript });
  } catch {
    console.error("[api/transcribe] request did not complete");
    return Response.json({ error: "VOICE_TRANSCRIPTION_FAILED" }, { status: 502 });
  }
}
