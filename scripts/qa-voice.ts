import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";

// Supply synthetic/non-sensitive speech fixtures; reports remain local and ignored.
const baseUrl = process.env.QA_BASE_URL || "http://localhost:3017";
const paths = process.argv.slice(2);
assert.ok(paths.length, "Pass one or more audio fixture paths to qa-voice.ts");
const types: Record<string, string> = { ".wav": "audio/wav", ".webm": "audio/webm", ".mp4": "audio/mp4", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".mp3": "audio/mpeg" };
const results: unknown[] = [];

async function main() {
  for (const path of paths) {
    const type = types[extname(path)];
    assert.ok(type, `Unsupported fixture extension: ${extname(path)}`);
    const form = new FormData();
    form.set("audio", new File([await readFile(path)], `voice-note${extname(path)}`, { type }));
    const started = performance.now();
    const response = await fetch(`${baseUrl}/api/transcribe`, { method: "POST", body: form, signal: AbortSignal.timeout(40_000) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(typeof body.transcript, "string");
    assert.ok(body.transcript.trim().length);
    if (process.env.QA_EXPECT_TRANSCRIPT) assert.match(body.transcript, new RegExp(process.env.QA_EXPECT_TRANSCRIPT, "i"));
    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: `voice-qa-${Date.now()}`, message: body.transcript, history: [] }),
      signal: AbortSignal.timeout(50_000),
    });
    const reply = await chat.json();
    assert.equal(chat.status, 200, JSON.stringify(reply));
    assert.equal(chat.headers.get("x-chat-provider"), "anthropic");
    assert.equal(chat.headers.get("x-chat-model"), process.env.QA_CLAUDE_MODEL || "claude-sonnet-5");
    const result = { file: basename(path), transcriptionStatus: response.status, transcript: body.transcript, reply: reply.message, provider: chat.headers.get("x-chat-provider"), model: chat.headers.get("x-chat-model"), elapsedMs: Math.round(performance.now() - started) };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  await mkdir("tmp/voice-tests", { recursive: true });
  await writeFile(process.env.QA_REPORT_PATH || "tmp/voice-tests/qa-report.json", JSON.stringify({ baseUrl, checkedAt: new Date().toISOString(), results }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
