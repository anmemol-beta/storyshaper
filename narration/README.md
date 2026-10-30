# Character narration

Story lines are read in each character's voice with Chatterbox:

| `speakerId` | Voice | Settings |
|---|---|---|
| `narrator` (and any unknown id) | Parent (`voice/ref_clip.wav`) | exaggeration 0.5, 0.7 on lines with "!" |
| `pig1`, `pig2`, `pig3` | Parent, acted (one voice for all three pigs) | exaggeration 0.8, cfg_weight 0.4, 1.1× tempo |
| `wolf` | LibriTTS-R speaker 1188 (`voice/characters/`, CC BY 4.0) | exaggeration 0.7 |

The casting comes from a listening test of four options (roadmap §5, `voice/characters.html`). Settings live in `casting.json`.

## Run

Needs the Chatterbox environment (`voice/.venv-chatterbox`) and `ffmpeg`.

```bash
voice/.venv-chatterbox/bin/python -m narration.server     # http://127.0.0.1:8100
python3 -m story_agent.server                              # http://127.0.0.1:8000/prototype/agent.html
```

The agent page reads every new passage and question aloud and highlights the line being read.
If the narration server is not running, the page uses the browser voice. Another server address: `agent.html?voiceServer=http://127.0.0.1:8101`.

## API

1. `POST /api/voice/lines` with `{"lines": [{"speakerId": "wolf", "text": "..."}]}` (1–20 lines, up to 500 characters each).
   All lines are queued at once, ahead of anything queued earlier, and generated in order.
   Returns `{"clips": [{"speakerId", "role", "text", "key", "url", "ready"}]}`.
2. `GET <url>?wait=20` returns the MP3. If the line is still being generated, the server holds the request up to `wait` seconds (max 30).

| Result | Meaning | Page should |
|---|---|---|
| `200 audio/mpeg` | Clip ready | Play it |
| `504 not_ready` | Still generating after `wait` | Read the line with the default voice and move on |
| `500 generation_failed` | Chatterbox failed on this line | Default voice |
| `404 not_found` | Line was never queued | Queue it first |

Clips are cached in `voice/cache/` (git-ignored) by role settings and text, so a line is generated once; the second reading is instant.
Only English is voiced; for Korean the page uses the browser voice.
Requests are accepted only on `127.0.0.1`/`localhost`, and only from local pages (CORS).

## Page module

`prototype/narration.js` defines `Narration`:

- `speak(lines, {key, language, onLine})`: queues the lines and plays them in order. `onLine(i)` is called as line `i` starts and with `-1` at the end. Calling `speak` with the same `key` again does nothing, so a re-render does not repeat the passage.
- `stop()`: cuts the reading at once. Call it when the child starts talking (so the mic does not hear the narration), and on page changes or restart.

## Checked on 2026-10-30 (Mac, MPS)

- `python3 -m unittest tests.test_narration`: roles, caching, newest-first queue, failure and timeout, CORS, request limits (fake voice, no model).
- Headless Chrome on `agent.html` with both servers: mock mode and live Muse Spark each read the opening and one turn (6–7 lines) with the cloned voice, no fallback to the browser voice.
  A new line took 3–6 s to generate; cached lines played immediately.
- Direct API: `wolf`, `pig1`, `pig3` lines were voiced by their roles in 3–4 s each.
- Not checked: Safari/iPad autoplay (Chrome allowed playback after the first tap), a full story with wolf lines in the agent flow, a cloud GPU.
