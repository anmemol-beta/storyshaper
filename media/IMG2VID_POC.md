# img2vid POC (수찬님)

## Current status

- The baseline media server and asset registry already live on `main`.
- `experiments/image_motion_poc.py` creates a real browser-playable MP4 from a single image using a slow camera zoom. This is **not AI image-to-video** and **must never be described as a generative video success**.
- AI image-to-video provider credentials, model access and actual generated output have **not** been verified or supplied in this task. There is no AI-video success claim.
- The script is intentionally isolated from voice, story-agent and the UI to avoid blocking the main P0 integration.

## Run independently

```bash
python experiments/image_motion_poc.py prototype/img/wolf_paper.jpg prototype/video/wolf_paper_motion.mp4
ffprobe -v error -show_entries format=duration -show_entries stream=codec_name,width,height -of json prototype/video/wolf_paper_motion.mp4
```

Output: H.264 MP4, 1280×720, 4 seconds, no audio. It merely moves the virtual camera across the original image. Do not register it as a generated wolf-blowing animation.

## POC acceptance for **AI** image-to-video (not yet met)

1. Select a specific input image and prompt with fixed seed/model/version where supported.
2. Invoke an image-to-video model with actual credentials and save the task ID, timing and cost.
3. Receive and download the actual generated video, confirm `ffprobe` metadata and playback.
4. Human review: the wolf and pigs are visually consistent, only permitted actions take place, and the selected house matches the story.
5. Keep generated media out of `scene_registry.json` until reviewed. Only then add an MP4 asset to `prototype/video/`, set `reviewed: true` and verify it through the existing `POST /api/media/jobs` response.
6. Check that cancellation, old scene/version, errors and still-image fallback do not block the book.

## Branch ownership

`img2vid`: media creation, validation and vetted video assets. `ui_mvp`: video player, state binding, loading/fallback visuals and UI tests. `narration/`, `voice/`, `speech/` are owned by the voice contributor; do not edit their internals.

The story screen must remain useful and render a still image if this POC is unavailable.
