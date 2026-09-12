import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { POST } from "./route";

function audioRequest(type = "audio/webm", bytes: BlobPart = "sample audio bytes", name = "note.webm") {
  const data = new FormData();
  data.set("audio", new File([bytes], name, { type }));
  return new Request("http://localhost/api/transcribe", { method: "POST", body: data });
}

function configure(t: TestContext, key = "test-openai-key", model?: string) {
  for (const [name, value] of Object.entries({ OPENAI_API_KEY: key, OPENAI_TRANSCRIPTION_MODEL: model })) {
    const original = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => { if (original === undefined) delete process.env[name]; else process.env[name] = original; });
  }
}

test("voice fails closed without an OpenAI key", async t => {
  configure(t, "");
  const mock = t.mock.method(globalThis, "fetch", () => { throw new Error("must not call a provider"); });
  const response = await POST(audioRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "VOICE_TRANSCRIPTION_NOT_CONFIGURED" });
  assert.equal(mock.mock.callCount(), 0);
});

for (const [type, name] of [["audio/webm;codecs=opus", "note.webm"], ["audio/mp4", "note.mp4"], ["audio/wav", "note.wav"]]) {
  test(`voice forwards ${type} bytes in OpenAI multipart and preserves mixed-language text`, async t => {
    configure(t);
    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
      assert.equal(options.method, "POST");
      assert.equal(new Headers(options.headers).get("authorization"), "Bearer test-openai-key");
      assert.equal(new Headers(options.headers).get("content-type"), null, "fetch must supply the multipart boundary");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get("model"), "gpt-transcribe");
      assert.equal(options.body.get("language"), null);
      assert.equal(options.body.get("languages"), null);
      const file = options.body.get("file");
      assert.ok(file instanceof File);
      assert.equal(file.name, name);
      assert.equal(file.type, type);
      assert.equal(await file.text(), "sample audio bytes");
      return Response.json({ text: "  我要三十个 black plates。  " });
    });
    const response = await POST(audioRequest(type, "sample audio bytes", name));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { transcript: "我要三十个 black plates。" });
  });
}

test("voice model override is controlled by the server, never the upload", async t => {
  configure(t, "test-openai-key", "configured-transcription-model");
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get("model"), "configured-transcription-model");
    return Response.json({ text: "One knife." });
  });
  const form = await audioRequest().formData();
  form.set("model", "untrusted-model");
  const response = await POST(new Request("http://localhost/api/transcribe", { method: "POST", body: form }));
  assert.equal(response.status, 200);
});

test("voice rejects missing, empty, oversized and unsupported files before transmitting", async t => {
  configure(t);
  const mock = t.mock.method(globalThis, "fetch", () => { throw new Error("must not transmit"); });
  const missing = new Request("http://localhost/api/transcribe", { method: "POST", body: new FormData() });
  assert.equal((await POST(missing)).status, 400);
  assert.equal((await POST(audioRequest("audio/webm", ""))).status, 400);
  assert.equal((await POST(audioRequest("audio/webm", new Uint8Array(4 * 1024 * 1024 + 1)))).status, 413);
  assert.equal((await POST(audioRequest("text/plain"))).status, 415);
  assert.equal(mock.mock.callCount(), 0);
});

test("empty or invalid transcripts never become chat messages", async t => {
  configure(t);
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ text: "   " }));
  for (const result of [{ text: "   " }, { text: 123 }, {}, null]) {
    mock.mock.mockImplementation(async () => Response.json(result));
    const response = await POST(audioRequest());
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "VOICE_TRANSCRIPT_EMPTY" });
  }
});

test("provider errors, bad JSON and timeouts produce safe retryable failures", async t => {
  configure(t);
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("private upstream error", { status: 401 }));
  for (const status of [401, 429, 500]) {
    mock.mock.mockImplementation(async () => new Response("private upstream error", { status }));
    const response = await POST(audioRequest());
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "VOICE_TRANSCRIPTION_FAILED" });
  }
  mock.mock.mockImplementation(async () => new Response("invalid JSON"));
  assert.equal((await POST(audioRequest())).status, 502);
  mock.mock.mockImplementation(async () => { throw new DOMException("private timeout detail", "TimeoutError"); });
  assert.equal((await POST(audioRequest())).status, 502);
  assert.doesNotMatch(JSON.stringify(logs), /private|test-openai-key|sample audio bytes/);
});
