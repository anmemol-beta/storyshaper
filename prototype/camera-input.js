/* Show-it answers for the story pages. Opens the camera in a <video>, takes one frame when asked,
   sends it to the local server (/api/see, see vision/server.py) and returns the object's name.
   No frame is kept here: the canvas is dropped after the upload. */
const CameraInput = (() => {
  "use strict";
  const MAX_SIDE = 768; // enough to recognise one held-up object, about 100 KB as JPEG

  function supported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && window.HTMLCanvasElement);
  }

  // Starts the preview in `video`. Returns {snap, close}: snap() resolves to a JPEG Blob of the
  // current frame and closes the camera; close() just closes it. Rejects with the browser's
  // NotAllowedError when camera permission is refused.
  async function open(video) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {facingMode: "user", width: {ideal: 1280}, height: {ideal: 720}}, audio: false
    });
    const close = () => {
      stream.getTracks().forEach(track => track.stop());
      video.srcObject = null;
    };
    video.srcObject = stream;
    await video.play();
    async function snap() {
      const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      close();
      return new Promise((resolve, reject) => canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error("snapshot_failed")), "image/jpeg", 0.85));
    }
    return {snap, close};
  }

  // An empty string means no single object was clearly shown; that is not an answer, so callers
  // ask the child to show it again. Server and network problems reject with error.code set.
  async function name(blob, language, {signal} = {}) {
    const response = await fetch(`/api/see?language=${encodeURIComponent(language)}`, {
      method: "POST", body: blob, signal, cache: "no-store", headers: {"Content-Type": "image/jpeg"}
    });
    let body;
    try { body = await response.json(); }
    catch { body = {}; }
    if (!response.ok || typeof body.object !== "string") {
      const error = new Error(body.error?.message || `The camera answer failed (${response.status}).`);
      error.code = body.error?.code || "vision_unavailable";
      error.status = response.status;
      throw error;
    }
    return body.object;
  }

  return {supported, open, name, MAX_SIDE};
})();
