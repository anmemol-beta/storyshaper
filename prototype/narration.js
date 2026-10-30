/* Reads story lines aloud with each character's voice from the local narration server (narration/server.py).
   Narration.speak(lines, {key, language, onLine}) queues every line at once, then plays them in order.
   A line that is not ready in time, or any server error, is read by the browser voice instead, so the story never stops.
   Narration.stop() cuts the current reading, e.g. when the child starts talking or the page changes. */
const Narration = (() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const server = params.get("voiceServer") || "http://127.0.0.1:8100";
  const WAIT = 20;          // seconds the server may hold a request while the line is generated
  let token = 0;
  let audio = null;
  let lastKey = null;
  let finish = null;        // resolves the clip that is playing, so stop() can end it early

  function stop() {
    token += 1;
    if (audio) { audio.pause(); audio = null; }
    if (finish) finish(true);
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  function playClip(url) {
    return new Promise(resolve => {
      const clip = new Audio(url);
      audio = clip;
      finish = resolve;
      clip.onended = () => resolve(true);
      clip.onerror = () => resolve(false);
      clip.play().catch(() => resolve(false));
    });
  }

  function browserSay(text, language) {
    return new Promise(resolve => {
      if (!("speechSynthesis" in window)) return setTimeout(resolve, 1500);
      const say = new SpeechSynthesisUtterance(text);
      say.lang = language === "ko" ? "ko-KR" : "en-US";
      const done = () => { clearTimeout(guard); resolve(); };
      const guard = setTimeout(resolve, 30000);
      say.onend = done;
      say.onerror = done;
      speechSynthesis.speak(say);
    });
  }

  async function queue(lines) {
    const response = await fetch(`${server}/api/voice/lines`, {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({lines})
    });
    if (!response.ok) throw new Error(`narration ${response.status}`);
    return (await response.json()).clips;
  }

  // key: skip re-reading the same passage (e.g. a re-render after an error). Only English has cloned voices.
  async function speak(lines, {key = null, language = "en", onLine = () => {}} = {}) {
    if (key !== null && key === lastKey) return;
    lastKey = key;
    stop();
    const my = token;
    const usable = lines.filter(line => String(line.text || "").trim());
    let clips = null;
    if (language === "en") {
      try { clips = await queue(usable.map(line => ({speakerId: line.speakerId || "narrator", text: line.text}))); }
      catch { clips = null; }
    }
    for (let i = 0; i < usable.length; i += 1) {
      if (my !== token) return;
      onLine(i);
      const played = clips ? await playClip(`${server}${clips[i].url}?wait=${WAIT}`) : false;
      if (my !== token) return;
      if (!played) await browserSay(usable[i].text, language);
    }
    if (my === token) onLine(-1);
  }

  return {speak, stop};
})();
