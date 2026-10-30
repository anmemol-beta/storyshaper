/* Push-to-talk recording for the story pages. Records one short answer, sends it to the local
   server (/api/transcribe, see speech/server.py) and returns the text. No audio is kept here. */
const VoiceInput = (() => {
  "use strict";
  const MAX_MS = 8000; // same limit as the picture book's listening phase
  const MIN_MS = 300;  // a shorter press is a tap, not an answer (speech/transcribe.py MIN_SPEECH_MS)
  // Chrome/Edge record WebM, Firefox Ogg, Safari and iPad MP4; the server converts all of them.
  const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];

  function supported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  // Starts recording. Returns {stop, done}: stop() ends early, done resolves to {blob, ms}.
  // Rejects with the browser's NotAllowedError when microphone permission is refused.
  async function record({maxMs = MAX_MS} = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
    const type = TYPES.find(candidate => MediaRecorder.isTypeSupported(candidate)) || "";
    const recorder = new MediaRecorder(stream, type ? {mimeType: type} : undefined);
    const chunks = [];
    let timer = null, started = 0;
    const release = () => { clearTimeout(timer); stream.getTracks().forEach(track => track.stop()); };
    const done = new Promise((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        release();
        resolve({blob: new Blob(chunks, {type: recorder.mimeType || type}), ms: performance.now() - started});
      };
      recorder.onerror = event => { release(); reject(event.error || new Error("recording_failed")); };
    });
    recorder.start();
    started = performance.now();
    timer = setTimeout(() => recorder.state !== "inactive" && recorder.stop(), maxMs);
    return {stop: () => { if (recorder.state !== "inactive") recorder.stop(); }, done};
  }

  // Takes what record() resolved. An empty string means nothing was heard, including a tap shorter
  // than MIN_MS, which never reaches the server. Server and network problems reject with error.code
  // set, so callers can keep them out of the child's missed-try count.
  async function transcribe({blob, ms}, {signal} = {}) {
    if (ms < MIN_MS || !blob.size) return "";
    const response = await fetch("/api/transcribe", {
      method: "POST", body: blob, signal, cache: "no-store",
      headers: {"Content-Type": blob.type.split(";")[0] || "application/octet-stream"}
    });
    let body;
    try { body = await response.json(); }
    catch { body = {}; }
    if (!response.ok || typeof body.transcript !== "string") {
      const error = new Error(body.error?.message || `Speech recognition failed (${response.status}).`);
      error.code = body.error?.code || "speech_unavailable";
      error.status = response.status;
      throw error;
    }
    return body.transcript;
  }

  return {supported, record, transcribe, MAX_MS, MIN_MS};
})();
