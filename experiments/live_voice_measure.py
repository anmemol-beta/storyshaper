"""Which lines of live.html are read in the parent's voice and which fall back to the browser voice?

    python3 experiments/live_voice_measure.py <voice id> <en|ko> "<answer 1>" "<answer 2>"

Needs scripts/demo.sh running. Opens live.html in headless Chromium with the saved voice selected, starts the story,
answers (or taps the first of the three words when the story offers them), and prints a timeline in ms:
"parent" = a cloned-voice clip started, "browser" = a line read by the browser voice (simulated, 60 ms per
character), "answer" = an answer was sent. Used for docs/internal/voice-worklog-2026-10-31.md §13-14.
"""
import json
import sys

from playwright.sync_api import sync_playwright

voice, lang, answers = sys.argv[1], sys.argv[2], sys.argv[3:]
INIT = """
window.__log = []; const t0 = performance.now(); const log = (k, v) => __log.push([Math.round(performance.now() - t0), k, v]);
const play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () { log(this.src.includes('/audio/') ? 'parent' : 'audio', this.src.split('/').slice(-2).join('/')); this.addEventListener('ended', () => log('ended', ''), {once: true}); return play.call(this); };
window.speechSynthesis.speak = u => { log('browser', u.text); setTimeout(() => u.onend && u.onend(), 60 * u.text.length); };
window.speechSynthesis.cancel = () => {};
"""
with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    pg.add_init_script(INIT)
    pg.goto("http://127.0.0.1:8000/prototype/live.html")
    pg.evaluate(f"localStorage.setItem('story-voice','{voice}');localStorage.setItem('story-voice-name','Dad');localStorage.setItem('story-language','{lang}')")
    pg.reload(); pg.wait_for_timeout(1500)
    pg.select_option("#language", lang); pg.wait_for_timeout(500)
    pg.click("#cover")
    for a in [None, *answers]:
        if a is not None:
            if pg.is_enabled("#answer"):
                pg.fill("#answer", a); pg.click("#send")
            else:                                    # choice mode: the story offers three words instead
                a = pg.locator("#choices button").first.text_content(); pg.locator("#choices button").first.click()
            pg.evaluate(f"__log.push([0,'answer',{json.dumps(a)}])")
            pg.wait_for_timeout(1000)
        pg.wait_for_function("!document.getElementById('answer').disabled || document.querySelector('#choices:not([hidden]) button')", timeout=240000)
        pg.wait_for_timeout(45000)          # let the page be read out
    log = pg.evaluate("__log"); b.close()
for row in log: print(row)
parent = sum(1 for r in log if r[1] == 'parent' and r[2].startswith(voice + '/')); browser = sum(1 for r in log if r[1] == 'browser')
print(f"SUMMARY {lang}: parent-voice clips {parent}, browser-voice lines {browser}")
