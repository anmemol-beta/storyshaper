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
    active.cancelServer = server;
    clearTimeout(active.timer);
    active.controller?.abort();
    if (server && active.jobId) {
      this.fetch('/api/media/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sessionId: active.binding.sessionId, jobId: active.jobId})}).catch(() => {});
    }
  }

  retry(snapshot) {
    if (this.active?.retrying) return;
    return this.update(snapshot, {retry: true});
  }

  fail(active, {reason = 'media_unavailable', retryable = true} = {}) {
    if (this.active !== active) return;
    active.retrying = false;
    this.onState({state: 'failed', reason, retryable});
  }

  async update(snapshot, {retry = false} = {}) {
    const binding = {sessionId: snapshot.sessionId, sceneId: snapshot.sceneId, version: snapshot.version};
    const key = JSON.stringify(binding);
    if (this.active?.key === key && !retry) return;
    // Translation creates a new binding for the same image; preserve its paid work.
    this.cancel({server: !retry && snapshot.diagnostics?.languageChanged !== true});
    if (!this.enabled) { this.onState({state: 'unavailable', retryable: false}); return; }
    if (!snapshot.mediaPlan || !['accept', 'complete'].includes(snapshot.decision)) {
      this.onState({state: snapshot.decision === 'ready' ? 'reference' : 'kept'});
      return;
    }
    const active = {key, binding, jobId: null, controller: null, timer: null,
      deadline: Date.now() + this.timeoutMs, live: snapshot.providerMode === 'live', retrying: retry};
    this.active = active;
    this.onState({state: active.live && this.liveImages && !snapshot.selection ? 'generating' : 'loading'});
    try {
      let result = await this.request('/api/media/jobs', active, {
        method: 'POST', body: JSON.stringify(binding)});
      if (this.active !== active) { this.cancelLateJob(active, result); return; }
      if (retry && result.apply === true && result.sessionId === binding.sessionId
          && result.sceneId === binding.sceneId && result.version === binding.version
          && result.status === 'failed' && result.generationRequested === true
          && result.generationRetryAvailable !== false) {
        // Only this explicit click may replace failed generation. retryOf is
        // idempotent on the server, including lost responses and repeated taps.
        this.onState({state: 'generating', retrying: true});
        result = await this.request('/api/media/jobs', active, {
          method: 'POST', body: JSON.stringify({...binding, retryOf: result.jobId})});
        if (this.active !== active) { this.cancelLateJob(active, result); return; }
      }
      active.jobId = result.jobId;
      // Drop a failed hidden bitmap before reassigning the same URL. The
      // displayed layer stays intact and ready pixels never regenerate here.
      if (retry) this.picture.next?.removeAttribute('src');
      this.consume(result, active);
    } catch (error) {
      this.fail(active, {reason: error.code, retryable: error.retryable});
    }
  }

  cancelLateJob(active, result) {
    // The response may identify a job only after the user has already left.
    if (active.cancelServer && result.jobId)
      this.fetch('/api/media/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sessionId: active.binding.sessionId, jobId: result.jobId})}).catch(() => {});
  }

  async request(path, active, options = {}) {
    const controller = new AbortController();
    active.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.fetch(path, {...options, signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, cache: 'no-store'});
      if (!response.ok) {
        const error = new Error('media_unavailable');
        try { error.code = (await response.json()).error?.code; } catch {}
        const permanent = response.status >= 400 && response.status < 500
          && ![408, 429].includes(response.status);
        error.retryable = !permanent && !['image_retry_limit', 'retry_not_allowed', 'stale_snapshot',
          'session_not_found', 'job_not_found', 'job_limit', 'closed', 'invalid_request'].includes(error.code);
        throw error;
      }
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
        || result.version !== binding.version) {
      this.fail(active, {reason: 'stale_snapshot', retryable: false});
      return;
    }
    if (result.apply !== true) {
      this.fail(active, {reason: result.reason, retryable: result.reason === 'retried'});
      return;
    }
    if (['queued', 'running'].includes(result.status)) {
      if (Date.now() >= active.deadline) {
        this.fail(active, {reason: 'timeout'});
        return;
      }
      active.timer = setTimeout(async () => {
        if (this.active !== active) return;
        try {
          const next = await this.request(`/api/media/jobs/${encodeURIComponent(active.jobId)}?sessionId=${
            encodeURIComponent(binding.sessionId)}`, active);
          this.consume(next, active);
        } catch (error) {
          this.fail(active, {reason: error.code, retryable: error.retryable});
        }
      }, this.pollMs);
      return;
    }
    const url = result.image?.url;
    const preparedChoice = result.status === 'ready' && result.source === 'prepared_choice'
      && result.generated === false && result.generationRequested === false
      && typeof url === 'string' && url.startsWith('/prototype/img/');
    // A prepared choice is an intentional image result, separate from the
    // substitute picture attached to a failed live generation.
    if (result.source === 'prepared_choice' && !preparedChoice) {
      this.fail(active, {reason: 'invalid_prepared_choice', retryable: false});
      return;
    }
    const missingAsset = !url && result.reason === 'scene_asset_unavailable';
    const retryable = !missingAsset && !(active.live && !result.generationRequested && !preparedChoice)
      && !(result.generationRequested && result.status === 'failed' && result.generationRetryAvailable === false);
    const limitReached = result.generationRequested && result.status === 'failed'
      && result.generationRetryAvailable === false && result.retriesRemaining === 0;
    const reason = limitReached ? 'image_retry_limit' : active.live && !result.generationRequested && !preparedChoice
      ? 'image_generation_unavailable' : result.reason;
    if (!url || !(url.startsWith('/prototype/img/') || url.startsWith('/api/media/images/'))) {
      this.fail(active, {reason, retryable});
      return;
    }
    const generated = result.status === 'ready' && result.generated === true
      && result.source === 'muse_image' && result.image.reviewed === true;
    // Never present a malformed "generated" record as a newly generated picture.
    if (result.generated === true && !generated) { this.fail(active); return; }
    this.picture.show(url, {
      onComplete: () => {
        if (this.active === active) {
          active.retrying = false;
          this.describePicture();
          this.onState({state: generated ? 'generated' : preparedChoice ? 'prepared' :
            result.generationRequested || active.live ? 'fallback' : 'prepared', image: result.image,
            source: result.source, video: result.video, reason, retryable});
        }
      },
      onError: () => this.fail(active, {reason: 'image_load_failed', retryable})
    });
  }
}
