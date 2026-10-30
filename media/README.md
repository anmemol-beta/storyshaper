# Image-to-video POC

Status: stages 1–2 implemented as a local-only media contract, asset resolver, job manager and HTTP API. No generated video yet.

Run `python -m media.server --port 8000`. See [the API guide](API.md) for requests, polling, cancellation, fallback behavior and client integration. The CLI does not load credentials or call external APIs.

See the [agent integration plan](integration-plan.md) for the proposed MediaSpec, action routing and staged PRs based on current main.

## Initial approach

Reuse `prototype/img/wolf_paper.jpg`, already generated for the book, so Meta API
access is not a prerequisite for this POC. Propose Runway `gen4_turbo` as the first
provider, with one five-second shot. This is a candidate, not a measured winner.
Runway requires its own developer account, API key and paid credits.

The source already depicts a wolf blowing and paper leaving the roof. Animate
that existing action rather than asking one shot to build, destroy and replace
the house. Review character identity and paper/wind causality before expanding
to straw and wood. Candy and ice cream need their own source images and action
prompts; do not reuse the wind clip for those materials.

## Prepare without any key

From the repository root:

```powershell
python media/prepare.py --out .tmp/media-paper-001
```

This writes a Runway-shaped `request.json` with an embedded local JPEG and an
`evidence.json` with input hash and explicit unexecuted status. It makes no network
call, reads no credential and does not create a video. Use a new output directory
for each run. The 3:2 source and proposed 16:9 output differ: inspect framing in
the first generation and prepare padded input if a character is cropped.

Official API documentation must be rechecked before implementing submission.
The next adapter should submit once, persist its task ID and poll that task with
a timeout; a poll failure must not automatically create another paid generation.

## Integration after a clip passes review

First integrate reviewed, pre-generated clips. A client receives a media record
containing `sessionId`, `storyId`, `sceneId`, `version`, `material`, `action`,
`outcome`, `status`, `imageUrl` and optional `videoUrl`. These fields describe the
proposed media contract; this POC does not implement the server or player.

- Keep the image visible while a video is absent, pending, failed or rejected.
- Play a ready clip only if the active session, scene and version still match.
- Stop playback on page change, recording start or leaving the page. Do not let a
  late video replace the current story branch.
- Preserve parent narration separately; use a muted inline clip initially.
- Provide replay/skip and a still image for reduced motion or playback failure.
- Cache reviewed assets by input hash, prompt/model/version and story action;
  user-specific generated assets also require a session/family access boundary.

Z Fold8 is the user's likely first development/test device, pending actual device
confirmation. Test folded/unfolded layouts, rotation and resizing during playback.
Keep the entire image visible initially (`object-fit: contain`) and verify usable
letterboxing on the real device. Target a broadly compatible MP4 delivery format
and validate playback on the actual device; codec compatibility is not tested yet.

## Cost and evaluation

As checked on 2026-10-29, official Runway pricing lists `gen4_turbo` at five credits
per second and one credit at USD 0.01. A five-second attempt is therefore about
USD 0.25 before tax. This is an estimate, not an executed charge, free allowance
or generation latency guarantee. No paid experiment was executed.

Review the criteria in `paper-wind.json`, recording model, input/prompt hashes,
task ID, elapsed time, charged credits and rejected outputs. Do not rank providers
without actual equivalent trials. Luma is an alternative if the first provider
fails the scene constraints; adding providers is not the first integration task.

References:
- [Runway API getting started](https://docs.dev.runwayml.com/guides/using-the-api/)
- [Runway pricing](https://docs.dev.runwayml.com/guides/pricing/)
- [Luma video API guide](https://docs.lumalabs.ai/docs/video-generation) (points to current Luma Agents documentation)
- [Team role and integration meeting](../docs/meetings/2026-10-28-2049-roles-and-integration.md)

## Scene pictures for every allowed material

The story agent only accepts the materials in `story_agent/story.json`, so the pictures it can ask for are a finite set: for each house and allowed material, the finished house (`build`) and what happens to it (the material's outcome). All 24 are now in `scene_registry.json`. The 16 that the book did not have were made ahead of time with Muse Image (`muse-image-1.0`) and are in `prototype/img/scenes/`. Made in advance, no child waits for a redraw, and every picture was looked at before it was committed.

```bash
python3 -m media.generate_scenes --dry-run     # list missing pictures and their prompts
python3 -m media.generate_scenes               # make them (MODEL_API_KEY in .env), then look at each one
python3 -m media.generate_scenes --only house1/cookie/eaten   # remake one picture
```

Each picture is an edit of an existing page (the empty plot for a build, the build for its outcome, the brick pages for stone), with the wolf from `wolf_paper.jpg` as a reference, so the watercolor style and the pigs stay the same. The prompt names only the pigs on that page: naming all three made the model draw all three on single-pig pages in the first run. On 2026-10-30 each edit took 10–25 s; one was rejected once by the content filter and passed on retry.
