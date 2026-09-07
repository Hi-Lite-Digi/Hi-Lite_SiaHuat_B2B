const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set(["audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav"]);

export async function POST(request: Request) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return Response.json({ error: "VOICE_TRANSCRIPTION_NOT_CONFIGURED" }, { status: 503 });
  try {
    const incoming = await request.formData();
    const audio = incoming.get("audio");
    if (!(audio instanceof File) || audio.size === 0) return Response.json({ error: "AUDIO_REQUIRED" }, { status: 400 });
    if (audio.size > MAX_AUDIO_BYTES) return Response.json({ error: "AUDIO_TOO_LARGE" }, { status: 413 });
    const contentType = audio.type.split(";")[0].toLowerCase();
    if (!ALLOWED_AUDIO_TYPES.has(contentType)) return Response.json({ error: "AUDIO_TYPE_NOT_SUPPORTED" }, { status: 415 });

    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", process.env.DEEPGRAM_MODEL || "nova-3");
    url.searchParams.set("detect_language", "true");
    url.searchParams.set("smart_format", "true");
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Token ${apiKey}`, "content-type": contentType },
      body: await audio.arrayBuffer(),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]),
      cache: "no-store",
    });
    if (!response.ok) {
      console.error("[api/transcribe] Deepgram request failed", { status: response.status });
      return Response.json({ error: "VOICE_TRANSCRIPTION_FAILED" }, { status: 502 });
    }
    const result = await response.json() as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
    const transcript = result.results?.channels?.map(channel => channel.alternatives?.[0]?.transcript ?? "").join(" ").trim() ?? "";
    if (!transcript) return Response.json({ error: "VOICE_TRANSCRIPT_EMPTY" }, { status: 422 });
    return Response.json({ transcript });
  } catch {
    console.error("[api/transcribe] request did not complete");
    return Response.json({ error: "VOICE_TRANSCRIPTION_FAILED" }, { status: 502 });
  }
}
