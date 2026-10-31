/* Moves the displayed page in place while it is read: wind from the wolf's mouth, what happens to the house,
   breathing pigs, a slow drift of the whole painting. Nothing is generated: the presets follow the server-approved
   mediaPlan.action, and SAM 3.1 regions (media/motion_regions.py) say where the wolf, pigs and house are.
   A scene's event starts when its narration reaches the line that describes it (cue), so picture and voice agree.
   A registered video clip replaces the event; reduced motion turns everything off. */
class StoryMotion {
  constructor(art, {current = () => art.querySelector('img.is-current'), manifest = 'img/motion/regions.json',
    fetch: request = (...args) => globalThis.fetch(...args),
    reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches} = {}) {
    this.art = art;
    this.current = current;
    this.manifestUrl = manifest;
    this.fetch = request;
    this.reducedMotion = reducedMotion;
    this.manifest = null;
    this.active = null;
  }

  // Words that describe each event, in both languages. The first narrated line with one starts the event.
  static CUES = {
    blown_away: /wolf|puff|huff|blow|blew|wind|늑대|후|불|바람/i,
    collapsed: /wolf|puff|huff|blow|blew|wind|tumble|fell|fall|늑대|후|불|바람|무너/i,
    stood: /wolf|puff|huff|blow|blew|wind|늑대|후|불|바람/i,
    eaten: /wolf|eat|ate|munch|bite|chomp|늑대|먹|냠/i,
    melted: /melt|sun|warm|drip|soft|녹|햇|따뜻|흘러|말랑/i,
    build: /build|built|made|make|짓|지었|만들/i,
  };

  // The line index (into the narrated lines) that starts the event: the first line whose text names it,
  // else the last story line before the question, so every event plays while the page is still being read.
  static cueLine(action, lines) {
    if (!lines.length) return null;
    const words = StoryMotion.CUES[action];
    if (!words) return 0;
    const found = lines.findIndex(text => words.test(String(text || '')));
    return found >= 0 ? found : lines.length - 1;
  }

  // Where an <img> with object-fit draws its picture inside its own box.
  static contentRect(boxWidth, boxHeight, width, height, fit = 'contain', position = '50% 50%') {
    if (!width || !height) return {x: 0, y: 0, width: boxWidth, height: boxHeight};
    const scale = fit === 'cover' ? Math.max(boxWidth / width, boxHeight / height)
      : fit === 'fill' ? null : Math.min(boxWidth / width, boxHeight / height);
    if (scale === null) return {x: 0, y: 0, width: boxWidth, height: boxHeight};
    const w = width * scale, h = height * scale;
    const [px, py] = String(position).split(/\s+/).map(part => part.endsWith('%') ? parseFloat(part) / 100 : 0.5);
    return {x: (boxWidth - w) * (px ?? 0.5), y: (boxHeight - h) * (py ?? 0.5), width: w, height: h};
  }

  // Pictures without SAM regions (a newly generated page) use where the book usually draws them.
  static DEFAULT_REGIONS = {wolf: [0, 0.27, 0.23, 0.56], house: [0.42, 0.09, 0.94, 0.7], pigs: [[0.29, 0.5, 0.5, 0.9]]};

  loadManifest() {
    this.manifest ??= Promise.resolve(this.fetch(this.manifestUrl, {cache: 'no-store'}))
      .then(response => response.ok ? response.json() : {images: {}}).catch(() => ({images: {}}));
    return this.manifest;
  }

  // A new page is on screen. action: mediaPlan.action; narrated: its lines will be read aloud (cue() starts the event),
  // otherwise the event starts by itself; video: a reviewed clip plays the event instead.
  scene({action = null, lines = [], narrated = true, video = false} = {}) {
    this.stop({settle: false});
    if (this.reducedMotion()) return;
    const image = this.current();
    if (!image) return;
    const active = {image, action, video, played: false, cueKey: null, paused: false, clock: 0, last: null,
      particles: [], schedule: [], animations: [], sprites: {}, regions: StoryMotion.DEFAULT_REGIONS,
      cue: StoryMotion.cueLine(action, lines), frame: null, observer: null, drift: []};
    this.active = active;
    this.buildStage(active);
    this.startDrift(active);
    this.motes(active, 10);
    this.loop(active);
    const file = (image.getAttribute('src') || '').match(/(?:^|\/)img\/(.+)$/)?.[1];
    this.loadManifest().then(manifest => {
      if (this.active !== active) return;
      const record = file && manifest.images?.[file];
      if (record) this.useRegions(active, record);
      this.idle(active);
      if (!narrated && !video) this.after(active, 0.9, () => this.play(active));
    });
  }

  // Called when the narration actually starts voicing a line (Narration.speak onSpeak). key: one reading of the page;
  // reading the page again (Play after it ended, read aloud switched on) plays the event again.
  cue(index, key = null) {
    const active = this.active;
    if (!active || active.video || active.cue === null) return;
    if (key !== active.cueKey) { active.cueKey = key; active.played = false; }
    if (index === active.cue && !active.played) this.play(active);
  }

  // Play the event now, without waiting for its line (read aloud was switched off).
  start() { if (this.active) this.play(this.active); }

  pause() {
    const active = this.active;
    if (!active || active.paused) return;
    active.paused = true;
    for (const animation of active.animations) animation.pause();
  }

  resume() {
    const active = this.active;
    if (!active || !active.paused) return;
    active.paused = false;
    active.last = null;
    for (const animation of active.animations) if (animation.playState === 'paused') animation.play();
  }

  // Leave the page: ease the drift back so the next picture fades in from a still frame.
  stop({settle = true} = {}) {
    const active = this.active;
    this.active = null;
    if (!active) return;
    cancelAnimationFrame(active.frame);
    active.observer?.disconnect();
    for (const animation of active.animations) animation.cancel();
    for (const animation of active.drift) {
      const target = animation.effect?.target;
      const transform = target && settle ? getComputedStyle(target).transform : 'none';
      animation.cancel();
      if (target && settle && transform !== 'none') target.animate([{transform}, {transform: 'none'}], {duration: 450, easing: 'ease-out'});
    }
    active.stage.remove();
  }

  buildStage(active) {
    const stage = document.createElement('div');
    stage.className = 'motion-stage';
    stage.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    stage.append(canvas);
    active.stage = stage;
    active.canvas = canvas;
    active.context = canvas.getContext('2d');
    this.art.append(stage);
    this.layout(active);
    if (typeof ResizeObserver !== 'undefined') {
      active.observer = new ResizeObserver(() => this.layout(active));
      active.observer.observe(this.art);
    }
    active.colors = this.sampler(active.image);
  }

  layout(active) {
    const image = active.image, style = getComputedStyle(image);
    const box = {width: image.clientWidth, height: image.clientHeight};
    const rect = StoryMotion.contentRect(box.width, box.height, image.naturalWidth, image.naturalHeight,
      style.objectFit, style.objectPosition);
    const offset = {x: image.offsetLeft + rect.x, y: image.offsetTop + rect.y};
    Object.assign(active.stage.style, {left: offset.x + 'px', top: offset.y + 'px', width: rect.width + 'px', height: rect.height + 'px',
      // The drift scales the picture around its box's centre; the stage must use the same point to stay aligned.
      transformOrigin: `${box.width / 2 + image.offsetLeft - offset.x}px ${box.height / 2 + image.offsetTop - offset.y}px`});
    const ratio = globalThis.devicePixelRatio || 1;
    active.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    active.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    active.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (active.width && active.width !== rect.width) active.particles = active.particles.filter(p => p.kind === 'mote');
    active.width = rect.width;
    active.height = rect.height;
  }

  // Colours of the picture itself, so straw flies off as straw and crumbs look like the cookie.
  sampler(image) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = Math.max(1, Math.round(96 * (image.naturalHeight / image.naturalWidth || 0.66)));
      const context = canvas.getContext('2d', {willReadFrequently: true});
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return (x, y) => {
        // Average a small patch so an ink outline doesn't become a black flake, then lift dark colours.
        const rgb = [0, 0, 0];
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const px = Math.min(canvas.width - 1, Math.max(0, Math.round(x * canvas.width) + dx));
          const py = Math.min(canvas.height - 1, Math.max(0, Math.round(y * canvas.height) + dy));
          const i = (py * canvas.width + px) * 4;
          rgb[0] += pixels[i]; rgb[1] += pixels[i + 1]; rgb[2] += pixels[i + 2];
          count += 1;
        }
        const mean = rgb.map(value => value / count);
        const lift = Math.max(0, 0.6 - (0.3 * mean[0] + 0.59 * mean[1] + 0.11 * mean[2]) / 255);
        return mean.map((value, i) => Math.round(value + ([236, 214, 160][i] - value) * lift)).join(',');
      };
    } catch { return () => '214,180,110'; }
  }

  useRegions(active, record) {
    const [width, height] = record.size;
    const norm = ([x1, y1, x2, y2]) => [x1 / width, y1 / height, x2 / width, y2 / height];
    const of = label => record.objects.filter(object => object.label === label);
    active.regions = {wolf: of('wolf')[0] ? norm(of('wolf')[0].box) : null,
      house: of('house')[0] ? norm(of('house')[0].box) : null, pigs: of('pig').map(object => norm(object.box))};
    const place = object => {
      const sprite = document.createElement('img');
      sprite.src = 'img/' + object.sprite;
      sprite.alt = '';
      sprite.decoding = 'async';
      const [x1, y1, x2, y2] = norm(object.spriteBox);
      Object.assign(sprite.style, {left: x1 * 100 + '%', top: y1 * 100 + '%', width: (x2 - x1) * 100 + '%', height: (y2 - y1) * 100 + '%'});
      // Pigs stand in front of the house, the wolf leans in from the side.
      sprite.style.zIndex = {house: 1, wolf: 2, pig: 3}[object.label];
      active.stage.insertBefore(sprite, active.canvas);
      return sprite;
    };
    active.sprites = {wolf: of('wolf')[0] && place(of('wolf')[0]), house: of('house')[0] && place(of('house')[0]),
      pigs: of('pig').map(place)};
  }

  animate(active, element, keyframes, options) {
    if (!element?.animate) return null;
    const animation = element.animate(keyframes, {fill: 'none', ...options});
    if (active.paused) animation.pause();
    active.animations.push(animation);
    return animation;
  }

  // Idea 3: the painting is never quite still. A slow drift, floating light, pigs breathing.
  startDrift(active) {
    const keyframes = [{transform: 'scale(1) translate(0px, 0px)'}, {transform: 'scale(1.025) translate(-5px, -3px)'}];
    const options = {duration: 16000, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out'};
    for (const target of [active.image, active.stage]) {
      if (target.animate) active.drift.push(target.animate(keyframes, options));
    }
  }

  idle(active) {
    for (const [index, pig] of active.sprites.pigs?.entries() || []) {
      pig.style.transformOrigin = '50% 100%';
      this.animate(active, pig, [{transform: 'translateY(0) scaleY(1)'}, {transform: 'translateY(-2px) scaleY(1.012)'}],
        {duration: 2400 + index * 300, delay: -index * 700, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out'});
    }
  }

  // Run fn at a time on the page's own clock, so a paused narration pauses the event too.
  after(active, seconds, fn) { active.schedule.push({at: active.clock + seconds, fn}); }

  loop(active) {
    const step = now => {
      if (this.active !== active) return;
      const dt = active.paused || active.last === null ? 0 : Math.min(0.05, (now - active.last) / 1000);
      active.last = now;
      if (!active.paused) {
        active.clock += dt;
        const due = active.schedule.filter(item => item.at <= active.clock);
        active.schedule = active.schedule.filter(item => item.at > active.clock);
        for (const item of due) item.fn();
        this.advance(active, dt);
      }
      this.draw(active);
      active.frame = requestAnimationFrame(step);
    };
    active.frame = requestAnimationFrame(step);
  }

  advance(active, dt) {
    for (const p of active.particles) {
      p.age += dt;
      p.vx += (p.ax || 0) * dt;
      p.vy += (p.ay || 0) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += (p.spin || 0) * dt;
      p.onMove?.(p);
      if (p.kind === 'mote' && (p.age > p.life || p.y < -0.05)) Object.assign(p, this.mote(), {age: 0});
    }
    active.particles = active.particles.filter(p => p.age < p.life);
  }

  draw(active) {
    const context = active.context, width = active.width, height = active.height;
    context.clearRect(0, 0, width, height);
    for (const p of active.particles) {
      const fade = Math.min(1, p.age / 0.15) * Math.min(1, (p.life - p.age) / (p.life * 0.4));
      const x = p.x * width, y = p.y * height, size = p.size * width;
      context.save();
      context.globalAlpha = Math.max(0, fade * (p.alpha ?? 1));
      context.translate(x, y);
      context.rotate(p.rot);
      if (p.kind === 'streak') {
        const length = Math.hypot(p.vx * width, p.vy * height) * 0.09;
        context.rotate(Math.atan2(p.vy * height, p.vx * width) - p.rot);
        context.strokeStyle = 'rgba(255,255,255,0.85)';
        context.lineWidth = Math.max(1.5, size);
        context.lineCap = 'round';
        context.beginPath();
        context.moveTo(-length, Math.sin(p.age * 12) * size * 2);
        context.quadraticCurveTo(-length / 2, -size * 2, 0, 0);
        context.stroke();
      } else if (p.kind === 'dust' || p.kind === 'mote') {
        const radius = size * (p.kind === 'dust' ? 1 + p.age * 2.2 : 1);
        const glow = context.createRadialGradient(0, 0, 0, 0, 0, radius);
        glow.addColorStop(0, `rgba(${p.color},0.8)`);
        glow.addColorStop(1, `rgba(${p.color},0)`);
        context.fillStyle = glow;
        context.beginPath();
        context.arc(0, 0, radius, 0, Math.PI * 2);
        context.fill();
      } else if (p.kind === 'drop') {
        context.fillStyle = `rgb(${p.color})`;
        context.beginPath();
        context.ellipse(0, 0, size * 0.55, size * (1 + p.age * 0.8), 0, 0, Math.PI * 2);
        context.fill();
      } else if (p.kind === 'spark' || p.kind === 'heart') {
        context.fillStyle = p.kind === 'heart' ? 'rgb(240,110,130)' : 'rgb(255,214,90)';
        context.scale(1 + Math.sin(p.age * 9) * 0.15, 1 + Math.sin(p.age * 9) * 0.15);
        context.font = `${Math.round(size * 2.4)}px system-ui, sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(p.kind === 'heart' ? '♥' : '✦', 0, 0);
      } else {
        context.fillStyle = `rgb(${p.color})`;
        context.fillRect(-size * (p.stretch || 1), -size / 2, size * 2 * (p.stretch || 1), size);
      }
      context.restore();
    }
  }

  mote() {
    return {kind: 'mote', x: Math.random(), y: 0.4 + Math.random() * 0.6, vx: (Math.random() - 0.5) * 0.01, vy: -0.012 - Math.random() * 0.012,
      size: 0.004 + Math.random() * 0.004, color: '255,244,205', alpha: 0.55, life: 9 + Math.random() * 7, age: Math.random() * 6, rot: 0};
  }

  motes(active, count) { for (let i = 0; i < count; i += 1) active.particles.push(this.mote()); }

  emit(active, count, make) {
    for (let i = 0; i < count; i += 1) active.particles.push({age: 0, rot: 0, ...make(i)});
  }

  // A point inside a normalized box: fx, fy in 0..1 across it.
  at(box, fx, fy) { return [box[0] + (box[2] - box[0]) * fx, box[1] + (box[3] - box[1]) * fy]; }

  play(active) {
    if (active.played || active.video) return;
    active.played = true;
    const preset = StoryMotion.PRESETS[active.action];
    if (preset) preset.call(this, active, {...StoryMotion.DEFAULT_REGIONS, ...Object.fromEntries(
      Object.entries(active.regions).filter(([, value]) => value && (!Array.isArray(value[0]) || value.length)))});
  }

  // The wolf takes a deep breath and blows; streaks of wind fly from its mouth to the house.
  blow(active, regions, {seconds = 2.2, onHit = null} = {}) {
    const [mx, my] = this.at(regions.wolf, 0.98, 0.5);
    const wolf = active.sprites.wolf;
    if (wolf) {
      wolf.style.transformOrigin = '30% 60%';
      this.animate(active, wolf, [{transform: 'scale(1)'}, {transform: 'scale(1.06) rotate(-1.5deg)', offset: 0.35},
        {transform: 'scale(0.98) rotate(1deg)', offset: 0.7}, {transform: 'scale(1)'}], {duration: 900, iterations: Math.ceil(seconds / 0.9)});
    }
    const [hx] = this.at(regions.house, 0.08, 0);
    for (let t = 0; t < seconds; t += 0.08) {
      this.after(active, t, () => this.emit(active, 2, () => {
        const [, ty] = this.at(regions.house, 0, 0.25 + Math.random() * 0.6);
        const speed = 0.9 + Math.random() * 0.5;
        return {kind: 'streak', x: mx, y: my + (Math.random() - 0.5) * 0.04, vx: speed, vy: (ty - my) * speed / Math.max(0.1, hx - mx),
          size: 0.0022 + Math.random() * 0.0015, life: Math.max(0.3, (hx - mx) / speed + 0.25), alpha: 0.8,
          onMove: onHit && (p => { if (!p.hit && p.x >= hx) { p.hit = true; onHit(p); } })};
      }));
    }
  }

  shake(active, element, {amount = 3, duration = 420, times = 4, origin = '50% 100%'} = {}) {
    if (!element) return;
    element.style.transformOrigin = origin;
    this.animate(active, element, [0, -1, 1, -0.6, 0.6, 0].map(f => ({transform: `translateX(${f * amount}px) rotate(${f * amount * 0.12}deg)`})),
      {duration, iterations: times});
  }

  hop(active, element, {height = 8, times = 2, delay = 0} = {}) {
    if (!element) return;
    element.style.transformOrigin = '50% 100%';
    this.animate(active, element, [{transform: 'translateY(0) scaleY(1)'}, {transform: 'translateY(1px) scaleY(0.96)', offset: 0.15},
      {transform: `translateY(-${height}px) scaleY(1.03)`, offset: 0.5}, {transform: 'translateY(0) scaleY(1)'}],
    {duration: 520, iterations: times, delay: delay * 1000, easing: 'ease-out'});
  }
}

// One preset per server-approved mediaPlan.action. Each one runs once per reading of the page.
StoryMotion.PRESETS = {
  blown_away(active, regions) {
    this.blow(active, regions, {seconds: 2.4});
    this.after(active, 0.5, () => this.shake(active, active.sprites.house, {amount: 3.5, times: 5}));
    for (const pig of active.sprites.pigs || []) this.after(active, 0.7, () => this.shake(active, pig, {amount: 2, times: 3}));
    for (let t = 0.6; t < 2.8; t += 0.1) {
      this.after(active, t, () => this.emit(active, 4, () => {
        const [x, y] = this.at(regions.house, Math.random(), Math.random() * 0.75);
        return {kind: 'flake', x, y, vx: 0.12 + Math.random() * 0.22, vy: -0.05 - Math.random() * 0.12, ax: 0.08, ay: 0.06,
          spin: (Math.random() - 0.5) * 9, size: 0.004 + Math.random() * 0.005, stretch: 1.5 + Math.random() * 2,
          color: active.colors(x, y), life: 1.4 + Math.random() * 1.2};
      }));
    }
  },

  collapsed(active, regions) {
    this.blow(active, regions, {seconds: 1.6});
    this.after(active, 0.5, () => this.shake(active, active.sprites.house, {amount: 4.5, times: 4}));
    this.after(active, 2.1, () => {
      const house = active.sprites.house;
      if (house) this.animate(active, house, [{transform: 'translateY(0)'}, {transform: 'translateY(5px) rotate(-0.8deg)', offset: 0.4},
        {transform: 'translateY(0)'}], {duration: 900, easing: 'ease-in-out'});
      this.emit(active, 26, () => {
        const [x, y] = this.at(regions.house, Math.random(), 0.92);
        return {kind: 'dust', x, y, vx: (Math.random() - 0.5) * 0.12, vy: -0.03 - Math.random() * 0.04, size: 0.012 + Math.random() * 0.01,
          color: '200,180,150', alpha: 0.7, life: 1.3 + Math.random() * 0.6};
      });
      this.emit(active, 18, () => {
        const [x, y] = this.at(regions.house, Math.random(), Math.random() * 0.5);
        return {kind: 'chip', x, y, vx: (Math.random() - 0.5) * 0.18, vy: -0.1 - Math.random() * 0.1, ay: 1.1,
          spin: (Math.random() - 0.5) * 12, size: 0.005 + Math.random() * 0.004, stretch: 1.6, color: active.colors(x, y), life: 1.1};
      });
    });
  },

  stood(active, regions) {
    // The wind breaks against the strong walls and the house doesn't move.
    this.blow(active, regions, {seconds: 2.8, onHit: p => { p.vx *= -0.25; p.vy = (Math.random() - 0.5) * 0.6; p.life = p.age + 0.35; }});
    this.after(active, 0.6, () => this.shake(active, active.sprites.house, {amount: 0.6, times: 3}));
    this.after(active, 3.0, () => {
      const wolf = active.sprites.wolf;
      if (wolf) this.animate(active, wolf, [{transform: 'translateY(0) rotate(0)'}, {transform: 'translateY(4px) rotate(2deg)'},
        {transform: 'translateY(0) rotate(0)'}], {duration: 1400, easing: 'ease-in-out'});
    });
  },

  eaten(active, regions) {
    const wolf = active.sprites.wolf;
    if (wolf) {
      wolf.style.transformOrigin = '50% 80%';
      this.animate(active, wolf, [{transform: 'rotate(0) scale(1)'}, {transform: 'rotate(-2deg) scale(1.03)'}, {transform: 'rotate(1.5deg) scale(0.99)'},
        {transform: 'rotate(0) scale(1)'}], {duration: 500, iterations: 5});
    }
    for (let t = 0.2; t < 2.6; t += 0.2) {
      this.after(active, t, () => this.emit(active, 5, () => {
        const [x, y] = this.at(regions.house, Math.random() * 0.4, 0.15 + Math.random() * 0.6);
        return {kind: 'chip', x, y, vx: (Math.random() - 0.6) * 0.15, vy: -0.12 - Math.random() * 0.12, ay: 0.9,
          spin: (Math.random() - 0.5) * 10, size: 0.004 + Math.random() * 0.004, stretch: 1, color: active.colors(x, y), life: 1.2};
      }));
    }
    this.after(active, 0.4, () => this.shake(active, active.sprites.house, {amount: 1.5, times: 5}));
  },

  melted(active, regions) {
    const house = active.sprites.house;
    if (house) {
      house.style.transformOrigin = '50% 100%';
      this.animate(active, house, [{transform: 'scale(1, 1)'}, {transform: 'scale(1.012, 0.985)'}, {transform: 'scale(1, 1)'}],
        {duration: 2600, iterations: 2, easing: 'ease-in-out'});
    }
    for (let t = 0; t < 4; t += 0.25) {
      this.after(active, t, () => this.emit(active, 2, () => {
        const [x, y] = this.at(regions.house, 0.05 + Math.random() * 0.9, 0.55 + Math.random() * 0.35);
        return {kind: 'drop', x, y, vx: 0, vy: 0.008 + Math.random() * 0.012, ay: 0.02, size: 0.004 + Math.random() * 0.003,
          color: active.colors(x, y - 0.02), life: 2.2 + Math.random() * 1.2};
      }));
    }
  },

  build(active, regions) {
    const house = active.sprites.house;
    if (house) {
      house.style.transformOrigin = '50% 100%';
      this.animate(active, house, [{transform: 'scale(0.985)'}, {transform: 'scale(1.015)', offset: 0.55}, {transform: 'scale(1)'}],
        {duration: 900, easing: 'cubic-bezier(.3,1.6,.5,1)'});
    }
    this.emit(active, 14, i => {
      const edge = i / 14, side = i % 4;
      const [x, y] = this.at(regions.house, side === 0 ? 0 : side === 1 ? 1 : edge, side === 2 ? 0 : side === 3 ? 1 : edge);
      return {kind: 'spark', x, y, vx: 0, vy: -0.02, size: 0.006 + Math.random() * 0.004, life: 1.1 + Math.random() * 0.6, age: -Math.random() * 0.6};
    });
  },

  move_to_next_house(active) {
    for (const [index, pig] of (active.sprites.pigs || []).entries()) this.hop(active, pig, {height: 7, times: 2, delay: index * 0.15});
  },

  safe_ending(active, regions) {
    for (const [index, pig] of (active.sprites.pigs || []).entries()) this.hop(active, pig, {height: 9, times: 3, delay: index * 0.18});
    for (let t = 0; t < 2.4; t += 0.3) {
      this.after(active, t, () => this.emit(active, 2, () => {
        const pig = regions.pigs[Math.floor(Math.random() * regions.pigs.length)];
        const [x, y] = this.at(pig, Math.random(), 0.1);
        return {kind: 'heart', x, y, vx: (Math.random() - 0.5) * 0.03, vy: -0.08 - Math.random() * 0.04, size: 0.008 + Math.random() * 0.004, life: 1.8};
      }));
    }
  },
};
