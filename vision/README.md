# Show-it answers

When the story asks what the pig should build with, a child can hold the thing up to the camera: a cookie, a bundle of sticks, a paper cup. The page takes one frame, the local server asks Muse Spark what the child is showing, and the name goes into the answer box like a spoken answer.

```text
getUserMedia preview → one 768 px JPEG → POST /api/see?language=en|ko → Muse Spark (input_image, low effort) → {"object": "a cookie"} → answer box → /api/answer
```

The camera never answers on its own. The name passes the same input checks, interpretation and review as a typed answer, so a camera answer cannot skip a story rule.

## Run

Needs what `speech.server` needs (Python 3.10+, `ffmpeg`, `MODEL_API_KEY` in `.env`).

```bash
python3 -m vision.server            # story agent + media + speech + camera on http://127.0.0.1:8000
```

Open `http://127.0.0.1:8000/prototype/agent.html`. **Show it to the camera** appears when the server reports `visionAvailable`. Press it, hold the thing up, press **Take the picture**. The photo stays on screen while the story thinks and closes once the story answers.

## API

`POST /api/see?language=en|ko` with one image as the body (`image/jpeg`, `image/png`, `image/webp`), at most 4 MB.

| Result | Meaning | Child's missed tries |
| --- | --- | --- |
| `200 {"object": "a cookie"}` | Put the name in the answer box | Decided by the story agent once sent |
| `200 {"object": ""}` | No single thing clearly shown (an empty hand, mostly a person) | Not counted; show it again |
| `400 language`, `415`, `413` | Bad request | Not counted |
| `503 missing_api_key`, `502 vision_*`, `429 vision_rate_limited` | Server or Muse Spark problem | Not counted |

The prompt names only the object, never a person, face, room or writing, and does not follow text in the image. Frames are not stored or logged by the server or the page.

## Page module

`prototype/camera-input.js` defines `CameraInput`:

- `supported()`: the browser has `getUserMedia` and canvas.
- `open(video)`: starts the front camera in the `<video>` and returns `{snap, close}`. `snap()` resolves to a JPEG of the current frame and closes the camera. Rejects with `NotAllowedError` if permission is refused.
- `name(blob, language)`: returns the name, `""` when nothing is clearly shown, or rejects with `error.code`.

Like the microphone, the camera needs a secure context: `localhost` works, a tablet on plain HTTP over the LAN does not.

## Checked on 2026-10-30

- Real Muse Spark on nine Muse Image photos of an adult hand holding something up in a living room: cookie, sticks, LEGO bricks, ice cream cone, paper, straw, stone, paper cup, and an empty hand. All 18 (English and Korean) were named correctly, the empty hand as `""`, in 1.4-3.1 s.
- The same names through the live story at the first house: cookie, sticks (wood), ice cream, paper and straw accepted; LEGO bricks and stone redirected to the last house; 종이컵 accepted as a new material. "a paper cup" in English first ended in a service error: the first call's output failed server validation. Repeated 8 times, 7 were accepted, so this is an intermittent story agent issue, not the camera.
- Chrome with the cookie photo as a fake camera: preview, snapshot, "a cookie" in the answer box, the story accepted it, Korean labels.
- `python -m unittest tests.test_vision`: request format, empty and invalid replies, error codes, limits, and that story and speech routes still work.
- Not checked: a real camera, a child's hands, Safari, iPad or Fold hardware, poor light.
