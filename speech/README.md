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

Open `http://127.0.0.1:8000/prototype/agent.html`. The **Speak an answer** button appears when the server reports `speechAvailable`. The recognized text goes into the answer box: press **Continue story** to use it, or speak again.

This server is `media.server` plus one route. Unlike `media.server`, it reads `.env`, so the key also enables the live story mode.

## API

`POST /api/transcribe` with the raw recording as the body and its type as `Content-Type` (`audio/webm`, `audio/ogg`, `audio/mp4`, `audio/wav`; codec parameters are ignored). At most 2 MB.

| Result | Meaning | Child's missed tries |
| --- | --- | --- |
| `200 {"transcript": "paper"}` | Send the text to `/api/answer` | Decided by the story agent |
| `200 {"transcript": ""}` | Nothing heard, or shorter than 300 ms | Send `""` to `/api/answer`; the agent counts one try |
| `400 audio_unreadable`, `415`, `413` | The recording itself is broken or not audio | Not counted; record again |
| `503 missing_api_key`, `502 speech_*`, `429 speech_rate_limited` | Server or Muse Voice problem | Not counted |

A press shorter than 300 ms never reaches the server: `VoiceInput.transcribe` returns `""` for it.

Requests send `keywords` with every material alias in `story_agent/story.json`, so words like "bricks" are preferred. `languageBias` is not sent: the documented examples do not cover Korean, and Korean was recognized without it in the 10/27 test.

## Page module

`prototype/voice-input.js` defines `VoiceInput`:

- `supported()`: the browser has `getUserMedia` and `MediaRecorder`.
- `record()`: opens the mic and returns `{stop, done}`. `done` resolves to `{blob, ms}`. Rejects with `NotAllowedError` if permission is refused; offer the picture cards then, without counting a try.
- `transcribe(clip)`: returns the text, or rejects with `error.code` for service problems.

The microphone needs a secure context: `localhost`/`127.0.0.1` works, but a tablet opening the laptop's LAN address over plain HTTP will not get the mic.

## Checked on 2026-10-30

- Real Muse Voice: macOS `say` recordings as WebM/Opus and MP4/AAC came back as `paper,` and `i would use sticks.` in 0.7–1.2 s.
- Chrome with a fake microphone against `python -m speech.server`: speaking "Paper!" filled the answer box and the story accepted it; a quick tap and a silent recording each counted one missed try (`Clarification`).
- `python -m unittest tests.test_speech`: conversion, request format, size and type limits, error codes, and that story and media routes still work on the same server.
- Not checked: Safari, iPad or Fold hardware, a child's voice, noisy rooms.
