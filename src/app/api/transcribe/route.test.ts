import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "./route";

function audioRequest(type = "audio/webm") {
  const data = new FormData();
  data.set("audio", new File(["sample audio bytes"], "note.webm", { type }));
  return new Request("http://localhost/api/transcribe", { method: "POST", body: data });
}

test("voice fails closed without a Deepgram key", async t => {
  const original = process.env.DEEPGRAM_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  t.after(() => { if (original !== undefined) process.env.DEEPGRAM_API_KEY = original; });
  t.mock.method(globalThis, "fetch", () => { throw new Error("must not call old workflow"); });
  const response = await POST(audioRequest());
  assert.equal(response.status, 503);
});

test("voice uses Deepgram's raw-audio API and returns the transcript contract", async t => {
  const original = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = "test-deepgram-key";
  t.after(() => { if (original === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = original; });
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.origin, "https://api.deepgram.com");
    assert.equal(url.searchParams.get("detect_language"), "true");
    assert.equal(new Headers(options.headers).get("authorization"), "Token test-deepgram-key");
    assert.equal(new Headers(options.headers).get("content-type"), "audio/webm");
    assert.ok(options.body instanceof ArrayBuffer);
    return Response.json({ results: { channels: [{ alternatives: [{ transcript: "我要三十个黑色盘子。" }] }] } });
  });
  const response = await POST(audioRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { transcript: "我要三十个黑色盘子。" });
});

test("voice rejects invalid file types without transmitting them", async t => {
  const original = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = "test-deepgram-key";
  t.after(() => { if (original === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = original; });
  t.mock.method(globalThis, "fetch", () => { throw new Error("must not transmit"); });
  assert.equal((await POST(audioRequest("text/plain"))).status, 415);
});

test("empty speech and provider failures return useful error codes", async t => {
  const original = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = "test-deepgram-key";
  t.after(() => { if (original === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = original; });
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ results: { channels: [] } }));
  assert.equal((await POST(audioRequest())).status, 422);
  mock.mock.mockImplementation(async () => new Response("private error", { status: 401 }));
  const response = await POST(audioRequest());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "VOICE_TRANSCRIPTION_FAILED" });
});
