# Push-to-talk answers

A child presses the mic, says an answer, and presses again (or stops talking for the 8 s limit). The page sends the recording to the local server, which converts it to the WAV that Muse Voice Transcribe accepts and returns the text.

```text
MediaRecorder (webm / ogg / mp4) → POST /api/transcribe → ffmpeg → 16 kHz mono WAV → Muse Voice Transcribe → {"transcript": "..."}
```

## Run

Needs Python 3.10+, `ffmpeg` on the PATH and `MODEL_API_KEY` in the repository's `.env`.

```bash
python3 -m speech.server            # story agent + media + speech on http://127.0.0.1:8000
```

Open `http://127.0.0.1:8000/prototype/agent.html`. The **Speak an answer** button appears when the server reports `speechAvailable`. The recognized text goes into the answer box: press **Continue story** to use it, or **That's not what I said** to immediately open touch choices. Silence, a short tap, microphone refusal, and recognition errors also open the choices immediately. The child can tap before the spoken invitation finishes; another recording is optional.

This server adds transcription and configures live image generation on top of `media.server`. It reads `.env`, so the key enables live story text and **a newly generated picture for every accepted answer**, followed by an independent image review. Mock mode uses prepared pictures without image calls. See [the media contract](../media/API.md). Use `python3 -m vision.server` for the same features plus the existing camera input.

## API

`POST /api/transcribe` with the raw recording as the body and its type as `Content-Type` (`audio/webm`, `audio/ogg`, `audio/mp4`, `audio/wav`; codec parameters are ignored). At most 2 MB.

| Result | Meaning | Child's missed tries |
| --- | --- | --- |
| `200 {"transcript": "paper"}` | Send the text to `/api/answer` | Decided by the story agent |
| `200 {"transcript": ""}` | Nothing heard, or shorter than 300 ms | Open local touch choices immediately; no additional empty-answer request |
| `400 audio_unreadable`, `415`, `413` | The recording itself is broken or not audio | Not counted; open touch choices immediately |
| `503 missing_api_key`, `502 speech_*`, `429 speech_rate_limited` | Server or Muse Voice problem | Not counted; open touch choices immediately |

A press shorter than 300 ms never reaches the server: `VoiceInput.transcribe` returns `""` for it.

The local fallback uses the current question's server-authored choices. A tap submits `choiceId` with session/question/version to `/api/answer`; the server validates membership even if it has not received a failure report. It uses its own option label and value, places the source question context in `selection`/`mediaPlan.selection`, and needs no model call. `attempts` counts only unaccepted answers submitted to the story API; local microphone failures do not make an extra request just to increment it. A touch answer or restart stops recording and aborts transcription, and late results cannot overwrite the new question.

Requests send `keywords` with every material alias in `story_agent/story.json`, so words like "bricks" are preferred. `languageBias` is not sent: the documented examples do not cover Korean, and Korean was recognized without it in the 10/27 test.

## Page module

`prototype/voice-input.js` defines `VoiceInput`:

- `supported()`: the browser has `getUserMedia` and `MediaRecorder`.
- `record()`: opens the mic and returns `{stop, done}`. `done` resolves to `{blob, ms}`. Rejects with `NotAllowedError` if permission is refused; offer the picture cards then, without counting a try.
- `transcribe(clip)`: returns the text, or rejects with `error.code` for service problems.

The microphone needs a secure context: `localhost`/`127.0.0.1` works, but a tablet opening the laptop's LAN address over plain HTTP will not get the mic.

## Checked on 2026-10-30

- Integrated server: a 1.8 s synthetic adult sentence encoded as browser-style WebM/Opus went through `/api/transcribe` and returned `i want to build a house with paper..`. This validates conversion and the live service; it does not validate a physical microphone or child's voice.

- Real Muse Voice: macOS `say` recordings as WebM/Opus and MP4/AAC came back as `paper,` and `i would use sticks.` in 0.7–1.2 s.
- Earlier Chrome check with a fake microphone against `python -m speech.server`: speaking "Paper!" filled the answer box and the story accepted it; a quick tap and a silent recording each counted one missed try (`Clarification`). That was the previous flow. The new first-failure UI opens choices locally; automated UI tests cover silence, permission denial, recognition errors, rejected words and late transcripts.
- `python -m unittest tests.test_speech`: conversion, request format, size and type limits, error codes, and that story and media routes still work on the same server.
- Not checked: Safari, iPad or Fold hardware, a child's voice, noisy rooms.
