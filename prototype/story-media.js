/* The lab's image player. Every request is bound to one server-approved story snapshot. */
class StoryMediaPlayer {
  constructor(current, next, {onState = () => {}, fetch: request = (...args) => globalThis.fetch(...args),
    transition = new StoryImageTransition(current, next), pollMs = 750, timeoutMs = 150000} = {}) {
    this.current = current;
    this.next = next;
    this.picture = transition;
    this.fetch = request;
    this.onState = onState;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.active = null;
    this.enabled = false;
    this.liveImages = false;
  }

  configure({mediaAvailable = false, imageGenerationAvailable = false} = {}) {
    this.enabled = mediaAvailable;
    this.liveImages = imageGenerationAvailable;
  }

  reset() {
    this.cancel();
    this.picture.show('img/intro.jpg', {onComplete: () => this.describePicture()});
    this.onState({state: 'reference'});
  }

  describePicture() {
    // The transition swaps the two layers. Keep only the visible layer accessible.
    this.picture.current?.removeAttribute('aria-hidden');
    this.picture.current?.setAttribute('alt', typeof AgentLanguage === 'undefined'
      ? 'Story illustration' : AgentLanguage.text('Story illustration'));
    this.picture.next?.setAttribute('aria-hidden', 'true');
  }

  cancel({server = true} = {}) {
    const active = this.active;
    this.active = null;
    this.picture.cancel();
    if (!active) return;
    clearTimeout(active.timer);
    active.controller?.abort();
    if (server && active.jobId) {
      this.fetch('/api/media/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sessionId: active.binding.sessionId, jobId: active.jobId})}).catch(() => {});
    }
  }

  async update(snapshot) {
    const binding = {sessionId: snapshot.sessionId, sceneId: snapshot.sceneId, version: snapshot.version};
    const key = JSON.stringify(binding);
    if (this.active?.key === key) return;
    // Translation creates a new binding for the same image; preserve its paid work.
    this.cancel({server: snapshot.diagnostics?.languageChanged !== true});
    if (!this.enabled) { this.onState({state: 'unavailable'}); return; }
    if (!snapshot.mediaPlan || !['accept', 'complete'].includes(snapshot.decision)) {
      this.onState({state: snapshot.decision === 'ready' ? 'reference' : 'kept'});
      return;
    }
    const active = {key, binding, jobId: null, controller: null, timer: null,
      deadline: Date.now() + this.timeoutMs, live: snapshot.providerMode === 'live'};
    this.active = active;
    this.onState({state: active.live && this.liveImages ? 'generating' : 'loading'});
    try {
      const result = await this.request('/api/media/jobs', active, {
        method: 'POST', body: JSON.stringify(binding)});
      if (this.active !== active) return;
      active.jobId = result.jobId;
      this.consume(result, active);
    } catch {
      if (this.active === active) this.onState({state: 'failed'});
    }
  }

  async request(path, active, options = {}) {
    const controller = new AbortController();
    active.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.fetch(path, {...options, signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, cache: 'no-store'});
      if (!response.ok) throw new Error('media_unavailable');
      return await response.json();
    } finally {
      clearTimeout(timeout);
      if (active.controller === controller) active.controller = null;
    }
  }

  consume(result, active) {
    if (this.active !== active) return;
    const binding = active.binding;
    if (result.sessionId !== binding.sessionId || result.sceneId !== binding.sceneId
        || result.version !== binding.version || result.apply !== true) {
      this.onState({state: 'failed'});
      return;
    }
    if (['queued', 'running'].includes(result.status)) {
      if (Date.now() >= active.deadline) {
        this.onState({state: 'failed'});
        this.cancel();
        return;
      }
      active.timer = setTimeout(async () => {
        if (this.active !== active) return;
        try {
          const next = await this.request(`/api/media/jobs/${encodeURIComponent(active.jobId)}?sessionId=${
            encodeURIComponent(binding.sessionId)}`, active);
          this.consume(next, active);
        } catch {
          if (this.active === active) this.onState({state: 'failed'});
        }
      }, this.pollMs);
      return;
    }
    const url = result.image?.url;
    if (!url || !(url.startsWith('/prototype/img/') || url.startsWith('/api/media/images/'))) {
      this.onState({state: 'failed'});
      return;
    }
    const generated = result.status === 'ready' && result.generated === true
      && result.source === 'muse_image' && result.image.reviewed === true;
    // Never present a malformed "generated" record as a newly generated picture.
    if (result.generated === true && !generated) { this.onState({state: 'failed'}); return; }
    this.picture.show(url, {
      onComplete: () => {
        if (this.active === active) {
          this.describePicture();
          this.onState({state: generated ? 'generated' :
            result.generationRequested || active.live ? 'fallback' : 'prepared', image: result.image,
            video: result.video});
        }
      },
      onError: () => { if (this.active === active) this.onState({state: 'failed'}); }
    });
  }
}
