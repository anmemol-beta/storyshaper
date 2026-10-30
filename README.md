# StoryShaper

> Kids today *watch* stories on endless autoplay. They rarely get to *shape* one.

StoryShaper is an interactive picture book that a child steers with their voice.
The story stops and asks a question, the child answers out loud, and the next page is redrawn to match their idea.

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 26 – Nov 4, 2026).
Indie Developer track, theme *Build for Your World*.

![The paper house a child chose, redrawn by Muse Image](prototype/img/paper_house.jpg)

## How it works

In *The Three Little Pigs*, the child decides what each pig builds with.

1. The page is read aloud while each word lights up.
2. The story asks: *"What do you think he built his house with?"*
3. The child holds the mic and says *"Paper!"*
4. **Muse Voice Transcribe** turns the answer into text, **Muse Spark** writes the next lines around it, and **Muse Image** redraws the page with a paper house in the same style.
5. The wolf blows, and the child sees why a light house flies away. By the third pig, they reason that it needs something heavy and strong.

Silly answers are not blocked. They are folded back into the story: an ice cream house melts in the sun, so let's try something else.

## Try the prototype

To test **a newly generated picture for each accepted answer**, the microphone and camera together, install `ffmpeg`, copy `.env.example` to `.env`, set `MODEL_API_KEY` locally, and run (Python 3.10+):

```bash
python3 -m src.server
```

Run one app server at a time. If the port is already in use, open the existing app or stop that server with **Ctrl+C** in its terminal before running the command again. A port conflict exits with an explanation instead of a traceback.

Open [StoryShaper](http://127.0.0.1:8000/) to see the child-facing picture book and choose **AI version**. Each accepted typed, spoken, camera or touch answer starts one Muse Image edit and an independent Muse Spark image review. The previous page stays visible while drawing. The next passage, question and answer controls open only after the reviewed picture has loaded, decoded and finished fading onto the screen. **Reload picture** reloads an existing picture when download or decoding failed. If generation itself failed, this explicit click starts one replacement generation with independent review. Repeated clicks reuse that replacement; automatic retries remain disabled. Up to two manual generation retries are allowed per scene; exhausted or unavailable recovery directs the reader to restart. Generated pictures remain in this local server's memory and disappear on restart.

The microphone records up to eight seconds, transcribes with Muse Voice Transcribe, and puts editable words in the answer box. Press **Send** to submit. A first unaccepted answer, recording or recognition failure switches that question to **three keyword choices only**. Microphone, text and camera input stay hidden and disabled until a choice advances to a new question and its picture is displayed. Browser recording needs a secure context: `localhost` works; a tablet opening a plain HTTP LAN address does not.

Choose **Offline version** (formerly Demo) to test authored rules and prepared illustrations without an API key. **Choose** opens the three prepared keyword options without recording or calling Muse transcription. Camera recognition is available in AI version. The default server includes story generation, pictures, speech recognition and camera input at the same address.

Use **English / 한국어** at the top to switch the interface, current story, questions and choices. The language is remembered across both prototype screens. Switching preserves story progress and uses authored translations for the current passage; later model responses use the selected language. Earlier test records retain their original wording. Korean reading in the clickable book uses browser speech instead of the existing English recordings.

The agent keeps each question's purpose and permitted story transitions in authored metadata. Its wording follows the chosen material and actual event: a cookie house leads to a question about the wolf eating its walls; a loosely assembled wood house leads to collapse. The first model call interprets the answer and drafts the next passage and question wording. The server determines and validates the transition, identifiers and choices; the default adaptive path accepts simple known-material turns after local validation and adds an independent model review for new materials, complex answers, uncertain process wording, house transitions and the ending. Diagnostics report the actual call count and whether independent review ran. Invalid model output leaves story progress unchanged. **The first unaccepted answer or speech failure immediately opens three touch choices.** A short spoken and written invitation guides the child to tap; the cards work before the invitation finishes. Microphone or recognition failures open the already-authored choices locally, without another request. A service failure also offers those choices without counting a child failure. One tap follows server-validated authored story text without a story model call, clearly labeled as a fallback; live picture generation still runs for that accepted answer. The selected option and its original question context are included in `mediaPlan.selection` for image integration.

`python3 -m src.server` is the single app entry point and includes story text, live pictures, speech recognition and camera input. See [the speech setup](speech/README.md) and [media API](media/API.md) for component details.

Custom materials retain their server-approved identity in the generated picture request. Generation or review failure keeps the reader locked on its current passage and shows a recovery message; a prepared fallback never unlocks AI progression. Image prompts contain approved material, action and character facts; raw failed speech and camera frames do not enter the image request. Live story and transcription send their respective inputs to Meta. Live video generation, physical device validation and production family access controls remain unfinished. Parent-voice narration requires the separate narration service. The local server listens only on `127.0.0.1`; sessions and answers disappear on restart.

```bash
python3 -m unittest discover -s tests -v
```

See [the story-agent design and test guide](docs/internal/story-agent.md) for the API, scenario checks and current limits.

To compare with the always-reviewed story path, stop the current server and restart it with `STORY_AGENT_PIPELINE=two_call python3 -m src.server`. Both paths keep server validation and first-failure touch choices. Image generation uses `reasoning_strength: low` with independent image review; set `STORY_IMAGE_REASONING_STRENGTH=high` to compare refinement. See `.env.example` for settings. Call-count and prompt-size reductions are verified offline; live latency and generated quality still need comparison.

The main page, `prototype/index.html`, uses the child/iPad reader design from `live.html`; both files show the same reader. The developer diagnostics page `agent.html` is preserved separately and has no navigation link or button in the app UI. Open reader settings from the header to register or change a parent voice. The earlier fixed-story data and playback modules remain available as development fixtures.

## Meta models we use

| Model | Role |
|---|---|
| `muse-voice-transcribe-1.0` | Understands the child's spoken answer |
| `muse-spark-1.3` | Interprets the answer and writes the next lines |
| `muse-image-1.0` | Edits the current page to match the child's idea, keeping characters and style |
| `sam-3.1` | (Planned) Cuts a child's own drawing out of a photo to place it in the story |

## Repository

| Path | What's in it |
|---|---|
| `prototype/` | Clickable design prototype (HTML, CSS, JS) and the story pages |
| `experiments/` | Scripts that test each Meta API, measure latency, generate the story pages and narration, and check the story data |
| `docs/internal/` | Team planning notes (Korean) |
| `voice/` | Voice-cloning samples and a blind comparison page (`compare.html`) |

To rerun the experiments, put `MODEL_API_KEY=...` in a `.env` file at the repo root (it is git-ignored).

After editing `prototype/story.js`, check that every scene, picture and narration clip it points to exists:

```bash
node experiments/narration_lines.mjs   # refresh the list of lines to narrate
node experiments/check_story.mjs       # exits with an error if anything is missing
```

## Narration in a parent's voice

The Meta Model API has no text-to-speech, so the story is read aloud by an open-source voice-cloning model.
A parent records about 30 seconds once, and every page is read in their voice.

We blind-tested three models on the same 6.5-second reference clip and the same five story lines (1–5 scores):

| Model | Similarity | Naturalness | License |
|---|---|---|---|
| **Chatterbox** (chosen) | **4.0** | **4.2** | MIT |
| F5-TTS | 3.2 | 2.6 | Weights CC BY-NC |
| Qwen3-TTS 1.7B | 3.2 | 2.4 | Code Apache 2.0 |

Chatterbox also adds an inaudible watermark to every clip it generates, which helps guard against misuse of a cloned voice.

Each character has a voice that fits them. We compared four options by ear: the narrator and the three pigs are read in the parent's voice (the pigs a little livelier), and the wolf has a different stock voice (LibriTTS-R, CC BY 4.0), so a child always knows who is speaking. Changing only the pitch of the parent's voice scored lowest.

**A parent who is away can still read.** On `prototype/voice.html` a parent chooses whose voice it is (their own, a family member who agreed, or someone the family misses), then adds a video or a voice message, or reads a short bedtime passage that ends with a spoken permission sentence ("I'm happy for my voice to read stories to my child"), which is checked with Muse Voice Transcribe. StoryShaper finds the clearest ten seconds on a waveform, shows what **Muse Voice Transcribe** heard, plays a story line in that voice, and keeps only that ten-second clip. **Delete** removes the clip and every line read with it.

Lines are generated as the story needs them, newest first, and cached, so a line is made once. If a line isn't ready in time the browser voice reads it and the story keeps going.

The picture book then shows "Read by Dad" on its cover and reads in that voice; the reader can be changed in Settings.

```bash
scripts/demo.sh          # both servers, and every saved voice reads the whole book ahead (needs Chatterbox and ffmpeg)
scripts/demo.sh --wait   # the same, but wait until every line is voiced before recording a demo
```

Then open `http://127.0.0.1:8000/prototype/voice.html` to add a voice and `index.html` to hear the story. Details: [`narration/README.md`](narration/README.md).

## Progress

**Done**
- Added a local text-input story-agent playground with material-dependent questions, server-owned transitions, model validation, three-choice recovery, and clearly labeled offline/live modes. Automated tests cover all 50 authored material paths in English and Korean, custom materials, and error handling. Earlier three-call Korean Muse Spark runs passed interpretation, generation and review; live quality and latency evaluation of the new two-call path remains pending.
- Tested every Meta Model API capability we need: text, chat, image generation and editing, image understanding, speech to text (English and Korean), and SAM 3.1.
- Measured one story turn: speech to text ~3 s, next lines ~3–7 s, page redraw 12–20 s. The redraw is the bottleneck, so the design hides it behind narration.
- Built a clickable prototype of the full *Three Little Pigs* story with 13 pages generated by Muse Image, kept consistent by editing each page from the previous one.
- Found that the image content filter rejects some wolf scenes inconsistently; the page generator retries with softer wording.
- Picked Chatterbox for parent-voice narration after a blind test.
- Narrated the prototype in a parent's cloned voice: 40 pre-generated clips, one per line and answer branch, with a reading speed slider.
- Gave each character a voice (parent for the narrator and pigs, a stock voice for the wolf) through a local narration server that the story agent page uses, with a browser-voice fallback.
- Let a parent register a voice from a video, a voice message or a read-aloud passage, with consent, a preview, and deletion of the voice and everything read with it.

**Next**
- [ ] Wire the real pipeline into the web app: microphone → Muse Voice Transcribe → Muse Spark → Muse Image.
- [ ] Put the child's own words into the book as dialogue, with their recorded voice.
- [ ] Safety: guide unexpected or unsafe answers back into the story.
- [ ] Let a child draw themselves, cut the drawing out with SAM 3.1, and place it in the story.
- [ ] Test with a real child and adjust questions and timing.
- [ ] Record the 3-minute demo video and submit by Nov 4, 9:00 PM ET.
