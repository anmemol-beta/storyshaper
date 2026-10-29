// Keep the displayed bitmap until the next one has loaded and decoded. Swap the
// two actual layers after fading, rather than assigning src to the visible layer.
class StoryImageTransition {
  constructor(current, next, options = {}) {
    this.current = current;
    this.next = next;
    this.duration = options.duration ?? 420;
    this.loadTimeout = options.loadTimeout ?? 8000;
    this.reducedMotion = options.reducedMotion || (() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.active = null;
    this.current.classList.add('is-current');
  }

  settle() {
    const request = this.active;
    if (!request) return;
    if (request.fading) this.finish(request, false);
    else this.cancel();
  }

  cancel() {
    const request = this.active;
    if (!request) return;
    clearTimeout(request.timer);
    this.next.onload = this.next.onerror = this.next.ontransitionend = null;
    this.next.classList.remove('is-entering');
    this.active = null;
  }

  prepare(url, {onReady = () => {}, onError = () => {}} = {}) {
    this.settle();
    const request = {url, ready: false, fading: false, timer: null};
    this.active = request;
    const live = () => this.active === request;
    const fail = () => {
      if (!live()) return;
      this.cancel();
      onError();
    };
    const ready = () => {
      if (!live()) return;
      clearTimeout(request.timer);
      this.next.onload = this.next.onerror = null;
      request.ready = true;
      onReady();
    };
    if (this.current.getAttribute('src') === url) {
      ready();
      return;
    }
    let decoding = false;
    const loaded = () => {
      if (!live() || decoding) return;
      if (!this.next.naturalWidth) return fail();
      decoding = true;
      if (typeof this.next.decode === 'function') {
        try { this.next.decode().then(ready, fail); } catch (error) { fail(); }
      } else ready();
    };
    this.next.onload = loaded;
    this.next.onerror = fail;
    request.timer = setTimeout(fail, this.loadTimeout);
    this.next.src = url;
    if (this.next.complete) loaded();
  }

  reveal(onComplete = () => {}) {
    const request = this.active;
    if (!request?.ready || request.fading) return;
    request.onComplete = onComplete;
    if (this.current.getAttribute('src') === request.url || this.reducedMotion()) {
      return this.finish(request);
    }
    request.fading = true;
    // Commit the hidden layer's initial opacity before enabling its transition.
    void this.next.offsetWidth;
    this.next.ontransitionend = event => {
      if (event.target === this.next && event.propertyName === 'opacity') this.finish(request);
    };
    this.next.classList.add('is-entering');
    request.timer = setTimeout(() => this.finish(request), this.duration + 70);
  }

  finish(request, notify = true) {
    if (this.active !== request || !request.ready) return;
    clearTimeout(request.timer);
    this.next.onload = this.next.onerror = this.next.ontransitionend = null;
    if (this.current.getAttribute('src') !== request.url) {
      this.next.classList.add('is-current');
      this.next.classList.remove('is-entering');
      this.current.classList.remove('is-current');
      [this.current, this.next] = [this.next, this.current];
    }
    this.active = null;
    if (notify) request.onComplete?.();
  }

  show(url, options = {}) {
    this.prepare(url, {onReady: () => this.reveal(options.onComplete), onError: options.onError});
  }
}
