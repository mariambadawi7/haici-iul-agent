# STT language / domain-vocabulary test harness

Used to decide whether Layer 1's Whisper `prompt` could ship on the STT Webhook
workflow (`KNUv1TRbHWl3v6oS`) without breaking Arabic. See `docs/SYSTEM-CHANGES.md`
§7, "Layer 1 applied to the real voice path".

**Finding:** an all-English prompt makes Whisper romanise short Arabic
("أين خلدة؟" → "Eyni halda?"); `Guard Language` then rejects it on script-vs-label
disagreement. 6/6 short Arabic clips rejected. The bilingual prompt that shipped
rejects 0/6.

## Why it exists
No Arabic TTS voice is installed on this Windows host, so Arabic test audio is
synthesised with the Gemini TTS model the stack already uses. The Google
credential stays inside n8n — the harness drives it through a temporary
workflow rather than exporting the key.

## Steps
1. Create a temporary n8n workflow exposing `POST /webhook/tmp-claude-tts`
   → HTTP Request to `gemini-2.5-flash-preview-tts:generateContent`
   (credential `googlePalmApi`) → Respond with `{b64, mime}`.
2. `python gen_clips.py` — writes L16 PCM clips.
3. Transcode to what the browser records:
   `docker exec -i whisper ffmpeg -f s16le -ar 24000 -ac 1 -i pipe:0 -c:a libopus -b:a 32k -f webm pipe:1 < X.pcm > X.webm`
4. `python make_clone.py en|bi <webhook-path> "<name>"` — builds a clone of the
   live workflow with the prompt variant. Create + activate it via the n8n API so
   production is never used as a test bed.
5. `python run_stt.py <webhook-url> <label> webm` — one arm.
   `python repeat.py` — repeats short clips across all arms (determinism check).
6. `python build_put.py` — builds the production PUT payload. Note it takes
   `name`/`settings` from the TOP-LEVEL object and `nodes`/`connections` from
   `activeVersion`, and strips `binaryMode` (rejected by the public API schema).
7. Delete the temporary workflows.

## Gotchas
- `activeVersion` is what serves traffic; the top-level `nodes` is the editor
  draft. After any PUT, verify `versionId == activeVersionId`.
- Short clips (~1–2 s) are where prompt-induced romanisation shows. Long clips
  pass in every arm — testing only long clips would have missed this entirely.
- Clips are studio-clean synthetic speech. They probe the language/script logic,
  not microphone realism.
