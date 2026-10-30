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
scripts/demo.sh            # both servers; voices the book and the fillers for every saved voice ahead
scripts/demo.sh --wait     # ...and waits until all of it is voiced (before recording a demo)
```

Or one at a time: `voice/.venv-chatterbox/bin/python -m narration.server` (port 8100), `python3 -m src.server` (port 8000), and `python3 -m narration.warm` to voice ahead.

The agent page reads every new passage and question aloud and highlights the line being read.
If the narration server is not running, the page uses the browser voice. The app is at `http://127.0.0.1:8000/`; a custom narration address can be set with `index.html?voiceServer=http://127.0.0.1:8101`.

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

## Registering a parent's voice

`prototype/voice.html` (open it from the agent server: `http://127.0.0.1:8000/prototype/voice.html`) walks a parent through:

1. **Whose voice is this?** My own voice, a family member who agreed (e.g. a parent away for work or service), or a family member who has passed away. A name and a rights checkbox are required; public figures and people who have not agreed are excluded.
2. **Add a recording or a video.** Any file `ffmpeg` can read, or a 30-second recording in the browser. Only the sound track of the first 10 minutes is used.
3. **Choose a clear 10-second part.** The server suggests up to three parts with the most talking and checks length, share of speech, background noise and distortion. The clip is transcribed with **Muse Voice Transcribe** so the parent can see what was said.
4. **Hear a story line** in that voice.
5. **Save.** The full recording is deleted; only the clip (`ref.wav`) and `meta.json` with the consent statement are kept in `voice/profiles/<id>/` (git-ignored). The page stores the chosen voice in `localStorage["story-voice"]`, and `narration.js` sends it as `voiceId`.

**Delete voice** removes the clip and every story line read with it (`voice/cache/<id>/`).
A registered voice replaces the parent roles (narrator and pigs); the wolf keeps its stock voice.

| Route | Body | Result |
|---|---|---|
| `POST /api/voices` | the file itself, `Content-Type: audio/*` or `video/*` (max 100 MB) | `201` draft `{id, sourceSeconds, suggestions: [{start, end, speech}]}` |
| `GET /api/voices/<id>/full.wav` | | the draft's audio, to listen to the parts |
| `POST /api/voices/<id>/clip` | `{start, end}` | `{quality: {duration, speech, snrDb, ok, problems}, transcript}` |
| `POST /api/voices/<id>/preview` | `{}` | a clip like `/api/voice/lines` returns |
| `POST /api/voices/<id>/save` | `{name, relation: "me" \| "family_consented" \| "family_late", attested: true}` | saved meta |
| `GET /api/voices` | | `{voices: [{id, name, source, savedAt, consent}]}` |
| `DELETE /api/voices/<id>` | | `{deleted: id}` |

## Languages

The parent records once, in English, and the same voice reads **English and Korean**: English with Chatterbox, Korean with Chatterbox Multilingual from the same reference clip (`cfg_weight` 0.5, chosen by ear on `voice/korean.html`). Send `"language": "ko"` with `/api/voice/lines`; English cache keys are unchanged. The Korean picture book lines are in `prototype/audio/lines.ko.json` (written by `node experiments/narration_lines.mjs`) and are voiced ahead by `narration/warm.py` and on saving a voice. Korean fillers: `FILLERS_KO`.

On a Mac (MPS) a Korean line takes about 6–9 s to make, slower than it takes to play, so live Korean passages pause between lines; the picture book is fine once voiced ahead.

## Making a voice closer (fine-tuning, beta)

Chatterbox imitates a voice from at most 10 s of its reference clip, so recording more does not make the zero-shot voice closer. A parent can optionally teach it their way of speaking:

1. **Collect speech** on `prototype/voice-train.html` (linked from the voice setup's done page): read up to 100 short storybook sentences (each checked with Muse Voice Transcribe), and/or upload home videos and voice messages. Videos are cut at pauses into 1.5–12 s clips whose transcript becomes their text; the parent listens to each clip, corrects the words, or marks it "Don't use".
2. **Train** a LoRA on Chatterbox's T3 (rhythm, accent, phrasing; timbre still comes from the reference clip):
   `voice/.venv-ft/bin/python -m narration.finetune --voice <id>` — uses [gokhaneraslan/chatterbox-finetuning](https://github.com/gokhaneraslan/chatterbox-finetuning) (Apache-2.0, `voice/finetune-kit`, set up with its `setup.py`; English tokenizer folder `pretrained_models_en`), runs on Apple MPS. 48 sentences: ~2.6 min for 10 epochs.
3. **Compare** held-out lines before/after (and today's voice with `--current <id>`): `python -m narration.finetune_eval --run <name> --ref … --real …` writes a listening page.
4. **Use it**: `python -m narration.finetune_merge --run <name> --voice <id>` bakes the adapter into a T3 file in the voice's folder; the "Trained voice (beta)" switch on `voice.html` (`POST /api/voices/<id>/finetune`) makes the server read that voice's **English** parent lines with it. Korean keeps the multilingual model.

**Without training:** the practice sentences can also replace the 10 s reference clip. "Use my practice reading" on `voice-train.html` (`POST /api/voices/<id>/sample {"from": "practice"}`, needs 3 clearly read sentences) builds it from the sentences whose pitch and pitch movement are closest to the parent's usual reading, so lively or creaky readings don't push the story voice higher. The first clip is kept as `ref_original.wav`; "Go back to the first recording" (`{"from": "original"}`) restores it. The reference's content is in every cache key, so lines are read again in the new voice. On 현준's recordings, with default settings, held-out speaker similarity went from 0.83 to 0.89–0.91 (pitch 124–136 Hz vs 117 Hz before; docs/internal/voice-worklog-2026-10-31.md §10).

Deleting the voice deletes its clip, recordings, fine-tune dataset, runs trained from it and the merged model.

First results (현준's 48 sentences, 4.2 min): held-out speaker similarity and transcription match stayed within noise of the zero-shot voice (0.83 / 0.95–0.98; real recordings score 0.90 against each other), so the switch stays off until it is judged by ear.

## Where the voices are used

- **Integrated storybook (`index.html`, port 8000)**: passages and questions are read in character. The first unaccepted answer or speech failure opens active touch choices with narration that does not block tapping. Free answers can play a prepared interjection while waiting. The previous `agent.html` page was moved here and removed.
- **Voice setup (`voice.html`)**: saving a voice voices the whole picture book (`audio/lines.json`) and the "let's see…" lines in the background, and has a switch to read every character, the wolf too, in that voice (`localStorage["story-voice-all"]`, sent as `allRoles`).

## Page module

`prototype/narration.js` defines `Narration`:

- `speak(lines, {key, language, onLine})`: queues the lines and plays them in order. `onLine(i)` is called as line `i` starts and with `-1` at the end. Calling `speak` with the same `key` again does nothing, so a re-render does not repeat the passage.
- `prepare(lines)`: queues the lines and returns their clip URLs (or `null`), for pages that play audio themselves.
- `interject()`: says one of five short lines ("Hmm, let me think about that…") right away, and another every 8 s (at most three) until the next passage's first line is ready to play; skipped if not generated yet. `warm()` generates them ahead. The story never talks over a filler.
- `usesParentVoice()`: a voice is registered on this device.
- `stop()`: cuts the reading at once. Call it when the child starts talking (so the mic does not hear the narration), and on page changes or restart.

## Checked on 2026-10-30 (Mac, MPS)

- `python3 -m unittest tests.test_narration`: roles, caching, newest-first queue, failure and timeout, CORS, request limits (fake voice, no model).
- Headless Chrome on `agent.html` with both servers: mock mode and live Muse Spark each read the opening and one turn (6–7 lines) with the cloned voice, no fallback to the browser voice.
  A new line took 3–6 s to generate; cached lines played immediately.
- Direct API: `wolf`, `pig1`, `pig3` lines were voiced by their roles in 3–4 s each.
- Voice registration in headless Chrome: an MP4 with the parent's 27 s recording → 2 suggested parts (71% and 63% talking) → clip checked and transcribed in 3.8 s → preview line in 13.6 s → saved (only `ref.wav` and `meta.json` left) → the agent page read the story in that voice → **Delete voice** removed the profile and its cached lines.
- One Muse Voice Transcribe call hung past 30 s; a retry right after took 3 s. The server now gives up after 20 s and retries once; without a transcript the voice still works.
- Picture book with a registered voice: the cover page was read with that voice's clips. Right after saving, the first line waited about 10 s because the whole book was still being voiced; once voiced, lines play at once.
- Agent lab after saving a voice: a "let's see…" line played within 0.2 s of each of three answers; after three missed tries the choices "1. Paper. 2. Straw. 3. Cookie." were read.
- Not checked: Safari/iPad autoplay (Chrome allowed playback after the first tap), a full story with wolf lines in the agent flow, a cloud GPU.

## Speed (2026-10-31, Mac MPS)

The server prepares each voice's reference analysis once per clip instead of on every line: English 3.1 → 2.5 s per line, Korean 6.3 → 4.7 s (interleaved, same seeds; `experiments/narration_speed.py`). Korean passages written live can still pause between long lines; a faster GPU is the remaining fix. T3 in float16 fails on MPS.
