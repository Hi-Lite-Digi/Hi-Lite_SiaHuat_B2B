# Voice notes

The microphone records a note in the browser (up to 60 seconds). Customers can play it back, delete it, or press Send. `/api/transcribe` uploads the audio to OpenAI's transcription endpoint using `gpt-transcribe`; the transcript then follows the existing catalogue and Claude Sonnet reply flow.

Set the server-only `OPENAI_API_KEY` in local and production environments. `OPENAI_TRANSCRIPTION_MODEL` optionally overrides `gpt-transcribe`. This is separate from `ANTHROPIC_MODEL`, which continues to control replies and photo inspection. Deepgram is no longer required.

The upload retains its audio bytes, MIME type and filename. The server does not force English or translate the note. Files over 4 MiB are rejected before upload by the client and checked again by the route. The upstream request has a 30-second deadline, the browser allows 40 seconds, and Vercel allows 60 seconds. Empty speech is not sent as a chat message. Failed transcription preserves the recording for retry, with browser speech recognition as the existing fallback. Transcripts longer than the chat's 500-character limit keep the recording and ask for a shorter note.

## Verification

The route unit tests cover WebM/Opus, MP4 and WAV multipart forwarding, original-language text, server-controlled model selection, missing credentials, invalid/oversized files, empty transcripts, provider failures and timeouts. They also check that private upstream error content is not logged or returned.

Use non-sensitive or synthetic fixtures for the real-service check:

```powershell
$env:QA_BASE_URL = 'http://localhost:3017'
$env:QA_EXPECT_TRANSCRIPT = 'chef.*knife'
pnpm exec tsx scripts/qa-voice.ts tmp/voice-tests/chef-knife.webm tmp/voice-tests/chef-knife.mp4
```

The script sends each clip to the application transcription route and passes the returned text to the chat route. It requires a genuine Anthropic reply, not the deterministic fallback. Reports are saved under ignored `tmp/voice-tests/`; `QA_REPORT_PATH` can specify a separate report. Set `QA_BASE_URL` to the live site to verify production credentials and routing after deployment.

Also check microphone permission, recording, playback, Send, and the resulting reply in the target browser. Audio-file API checks alone do not test a physical microphone or every browser's permission behavior.
