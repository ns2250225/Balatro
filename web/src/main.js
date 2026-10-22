/* Browser glue: asset preload, native registration, input, render loop, error screen. */
(function (root) {
  'use strict';

  const ATB = root.ATB = root.ATB || {};
  const KEYMAP = {
    ' ': 'space', Enter: 'return', Escape: 'escape', Backspace: 'backspace', Tab: 'tab', Delete: 'delete',
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Shift: 'lshift', Control: 'lctrl', Alt: 'lalt',
    Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert',
  };
  const GAME_KEYS = new Set(['space', 'return', 'escape', 'backspace', 'tab', 'left', 'right', 'up', 'down']);

  function loveKey(e) {
    if (KEYMAP[e.key]) return KEYMAP[e.key];
    if (/^F\d+$/.test(e.key)) return e.key.toLowerCase();
    return e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  }

  /* ---------------------------------------------------------------- asset preload */
  function loadImages() {
    const entries = Object.entries(root.ATB_IMAGES || {});
    return Promise.all(entries.map(([name, uri]) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve([name, img]);
      img.onerror = () => resolve([name, null]);
      img.src = uri;
    }))).then((list) => { const m = {}; for (const [n, i] of list) if (i) m[n] = i; return m; });
  }

  function loadFont() {
    if (!root.FontFace) return Promise.resolve();
    const jobs = [];
    const add = (family, uri, weight) => {
      const ff = new FontFace(family, 'url(' + uri + ')', weight ? { weight } : undefined);
      jobs.push(ff.load().then((f) => { document.fonts.add(f); }).catch((e) => console.warn('font load failed', family, e)));
    };
    if (root.ATB_FONT_M6X11) add('ATBm6x11plus', root.ATB_FONT_M6X11);
    // glyph-subset copies of the game's Noto CJK fonts (optional; system fonts are the fallback)
    const c = root.ATB_CJK_FONTS || {};
    if (c.sc) add('ATBNotoSC', c.sc, 'bold'); if (c.tc) add('ATBNotoTC', c.tc, 'bold');
    if (c.jp) add('ATBNotoJP', c.jp, 'bold'); if (c.kr) add('ATBNotoKR', c.kr, 'bold');
    return Promise.all(jobs);
  }

  /* ---------------------------------------------------------------- language auto-detect */
  function detectLanguage() {
    const n = (navigator.language || 'en').toLowerCase();
    if (n.startsWith('zh')) return /tw|hk|mo|hant/.test(n) ? 'zh_TW' : 'zh_CN';
    if (n.startsWith('ja')) return 'ja';
    if (n.startsWith('fr')) return 'fr';
    if (n.startsWith('de')) return 'de';
    if (n.startsWith('es')) return /^es-(mx|419|ar|co|cl|pe|ve)/.test(n) ? 'es_419' : 'es_ES';
    if (n.startsWith('ko')) return 'ko';
    if (n.startsWith('ru')) return 'ru';
    if (n.startsWith('it')) return 'it';
    if (n.startsWith('pt')) return 'pt_BR';
    if (n.startsWith('pl')) return 'pl';
    if (n.startsWith('nl')) return 'nl';
    if (n.startsWith('id')) return 'id';
    return 'en-us';
  }

  /* ---------------------------------------------------------------- runtime */
  class Runtime {
    constructor(canvas, container) {
      this.canvas = canvas;
      this.container = container;
      try {
        this.gfx = new root.ATBGfx(canvas);
        this.text = new root.ATBTextRenderer(this.gfx);
      } catch (e) {
        // No WebGL2 (blocked GPU, old browser): fall back to Canvas2D on a fresh canvas so the game never goes black.
        console.warn('WebGL2 unavailable (' + e.message + '); using the Canvas2D fallback renderer');
        const fresh = canvas.cloneNode(false);
        canvas.parentNode.replaceChild(fresh, canvas);
        this.canvas = canvas = fresh;
        this.gfx = new root.ATBGfx2D(fresh);
        this.text = new root.ATBText2D(this.gfx);
      }
      this.audio = new root.ATBAudioEngine();
      this.images = {};
      this.running = false;
      this.mouse = { x: 0, y: 0 };
      this.touches = new Map();
      this.host = null;
      this.frames = 0;
      this.lastError = null;
      this.onError = null;
      this.perf = { lua: 0, gl: 0 };
      const vs = new URLSearchParams(root.location.search).get('atb_verify_stage');
      if (vs && vs !== 'initial') this.verifyScale = 0.5;
    }

    async init() {
      const [imgs] = await Promise.all([loadImages(), loadFont()]);
      for (const [name, img] of Object.entries(imgs)) {
        this.images[name] = { handle: this.gfx.addImage(img), w: img.naturalWidth, h: img.naturalHeight };
      }
      this.blank = this.gfx.addImage(Object.assign(document.createElement('canvas'), { width: 1, height: 1 }));
      this.fit();
      this._bindInput();
      root.addEventListener('resize', () => this.fit(true));
      if (root.visualViewport) root.visualViewport.addEventListener('resize', () => this.fit(true));
    }

    /* Size the canvas to its container; Balatro letterboxes internally in love.resize. */
    fit(notify) {
      const r = this.container.getBoundingClientRect();
      const w = Math.max(100, Math.floor(r.width)), h = Math.max(100, Math.floor(r.height));
      // headless verification renders at half resolution: software GL is the bottleneck there, the pixel-ratio check does not care
      const dpr = this.verifyScale || Math.min(root.devicePixelRatio || 1, 2);
      if (w === this.gfx.cssW && h === this.gfx.cssH && dpr === this.gfx.dpr && !this._force) return;
      this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
      this.gfx.resize(w, h, dpr);
      if (notify && this.pushEvent) this.pushEvent('resize', w, h);
    }

    /* ---------------------------------------------------------------- Lua host */
    boot() {
      const host = this.host = new root.ATBLuaHost();
      const g = this.gfx, t = this.text, a = this.audio, self = this;
      root.ATBCore.installCore(host, { onQuit: () => { self.running = false; } });
      const d = host.def.bind(host);

      d('setColor', (r, gg, b, al) => g.setColor(r, gg, b, al));
      d('setLineWidth', (w) => g.setLineWidth(w));
      d('origin', () => g.origin()); d('push', () => g.push()); d('pop', () => g.pop());
      d('translate', (x, y) => g.translate(x, y)); d('scale', (x, y) => g.scale(x, y)); d('rotate', (r) => g.rotate(r));
      d('clear', (r, gg, b, al) => g.clear(r, gg, b, al));
      d('rect', (f, x, y, w, h, rx) => g.rect(f, x, y, w, h, rx));
      d('circle', (f, x, y, r) => g.circle(f, x, y, r));
      d('polygon', (f, v) => g.polygon(f, v)); d('polyline', (v) => g.polyline(v));
      d('setShader', (n) => g.setShader(n)); d('shaderSend', (n, k, v) => g.shaderSend(n, k, v));
      d('drawImage', (h, dpi, qx, qy, qw, qh, x, y, r, sx, sy, ox, oy) => g.drawImage(h, dpi, qx, qy, qw, qh, x, y, r, sx, sy, ox, oy));
      d('drawText', (f, parts, x, y, r, sx, sy, ox, oy, cr, cg, cb, ca) => {
        g.setColor(cr, cg, cb, ca); t.drawText(f, parts, x, y, r, sx, sy, ox, oy);
      });
      d('newFont', (file, size) => t.newFont(file, size));
      d('textWidth', (f, s) => t.textWidth(f, s)); d('fontHeight', (f) => t.fontHeight(f)); d('fontAscent', (f) => t.fontAscent(f));
      d('loadImage', (path) => {
        const name = String(path).split('/').pop();
        const im = this.images[name];
        if (!im) { console.warn('missing image', path); return root.ATBLuaHost.multi(this.blank, 1, 1); }
        return root.ATBLuaHost.multi(im.handle, im.w, im.h);
      });
      d('present', () => g.flush());
      d('winSize', () => root.ATBLuaHost.multi(g.cssW, g.cssH));
      d('screenSize', () => root.ATBLuaHost.multi(root.screen.width || g.cssW, root.screen.height || g.cssH));
      d('mouseX', () => this.mouse.x); d('mouseY', () => this.mouse.y);
      d('touchList', () => Array.from(this.touches.keys()));
      d('setCursorVisible', (v) => { this.canvas.style.cursor = v ? 'default' : 'none'; });

      d('srcNew', (n, s) => a.srcNew(n, s)); d('srcPlay', (i) => a.srcPlay(i)); d('srcStop', (i) => a.srcStop(i));
      d('srcIsPlaying', (i) => a.srcIsPlaying(i)); d('srcVolume', (i, v) => a.srcVolume(i, v));
      d('srcPitch', (i, p) => a.srcPitch(i, p)); d('srcLoop', (i, l) => a.srcLoop(i, l));
      d('srcRelease', (i) => a.srcRelease(i)); d('srcStopAll', () => a.srcStopAll());

      host.run(root.ATB_LUA.files['atb/love.lua'], 'love.lua');
      host.run("love.graphics.present = __js.present", 'present');
      host.setGlobalFn('ATB_DETECT_LANG', detectLanguage);
      host.run("require 'main'", 'main');
      const stage = new URLSearchParams(root.location.search).get('atb_verify_stage') || '';
      host.setGlobalFn('ATB_VERIFY_STAGE_GET', () => stage);
      host.run("ATB_VERIFY_STAGE = ATB_VERIFY_STAGE_GET()", 'verify-stage');
      const ff = new URLSearchParams(root.location.search).get('atb_ff');
      if (ff) host.run('ATB_VERIFY_FF = ' + (parseFloat(ff) || 1), 'verify-ff');
      host.run(root.ATB_LUA.files['atb/patches.lua'], 'patches.lua');
      host.run('__atb_step = love.run()', 'love.run');       // runs love.load -> G:start_up
      this.stepRef = host.getGlobalRef('__atb_step');
      this.pushRef = host.getGlobalRef('__push_event');
      this.pushEvent = (...args) => { try { host.callRef(this.pushRef, ...args); } catch (e) { this.fail(e); } };
      this.pushEvent('resize', g.cssW, g.cssH);
      this._driveVerifyScene(stage);
    }

    /* ?atb_verify_stage=gameplay|stage2: step the game synchronously (no drawing) until the scripted scene is reached,
     * so headless snapshots do not depend on how many frames a slow software renderer manages to produce. */
    _driveVerifyScene(stage) {
      if (!stage || stage === 'initial') return;
      const host = this.host, done = host.getGlobalRef('ATB_VERIFY_DONE');
      const t0 = performance.now();
      let steps = 0;                     // iteration cap: performance.now() is virtual (frozen) under --virtual-time-budget
      root.__atbSimClock = 1000;
      while (!host.callRef(done) && steps < 4000) { root.__atbSimClock += 0.05; host.callRef(this.stepRef); steps++; }
      root.__atbSimClock = undefined; host.resetTimer();
      console.log('verify scene "' + stage + '" ' + (steps < 4000 ? 'reached' : 'NOT reached') + ' after ' + steps + ' steps (' + Math.round(performance.now() - t0) + ' ms)');
    }

    /* ---------------------------------------------------------------- loop */
    start() {
      this.running = true;
      const gen = this.gen = (this.gen || 0) + 1;      // a restarted runtime must never run two loops
      const tick = () => {
        if (!this.running || gen !== this.gen) return;
        try {
          const gs = this.gfx.stats, gl0 = gs.glMs;
          const t0 = performance.now();
          this.host.callRef(this.stepRef);
          const t1 = performance.now();
          this.gfx.flush();
          const t2 = performance.now();
          this.frames++;
          const st = this.perf, glMs = gs.glMs - gl0;      // GL submission time (inflated on software renderers)
          st.lua += (Math.max(0, t1 - t0 - (glMs - (t2 - t1))) - st.lua) * 0.05;   // pure Lua time per frame
          st.gl += (glMs - st.gl) * 0.05;
        } catch (e) { this.fail(e); return; }
        root.requestAnimationFrame(tick);
      };
      root.requestAnimationFrame(tick);
    }

    stop() { this.running = false; }

    fail(e) {
      this.running = false;
      this.lastError = e;
      console.error(e);
      if (this.onError) this.onError(e);
    }

    /* ---------------------------------------------------------------- input */
    _pos(e) {
      const r = this.canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    _bindInput() {
      const c = this.canvas;
      const btn = (b) => (b === 0 ? 1 : b === 2 ? 2 : 3);
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('pointerdown', (e) => {
        const [x, y] = this._pos(e);
        this.mouse.x = x; this.mouse.y = y;
        try { c.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        const touch = e.pointerType === 'touch';
        if (touch) { this.touches.set(e.pointerId, [x, y]); this.pushEvent && this.pushEvent('touchpressed', e.pointerId, x, y, 0, 0, 1); }
        this.pushEvent && this.pushEvent('mousepressed', x, y, btn(e.button), touch);
        e.preventDefault();
      });
      c.addEventListener('pointermove', (e) => {
        const [x, y] = this._pos(e);
        const dx = x - this.mouse.x, dy = y - this.mouse.y;
        this.mouse.x = x; this.mouse.y = y;
        const touch = e.pointerType === 'touch';
        if (touch && this.touches.has(e.pointerId)) this.touches.set(e.pointerId, [x, y]);
        this.pushEvent && this.pushEvent('mousemoved', x, y, dx, dy, touch);
      });
      const up = (e) => {
        const [x, y] = this._pos(e);
        this.mouse.x = x; this.mouse.y = y;
        const touch = e.pointerType === 'touch';
        if (touch) { this.touches.delete(e.pointerId); this.pushEvent && this.pushEvent('touchreleased', e.pointerId, x, y, 0, 0, 1); }
        this.pushEvent && this.pushEvent('mousereleased', x, y, btn(e.button), touch);
      };
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
      c.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
      root.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
        const k = loveKey(e);
        if (GAME_KEYS.has(k)) e.preventDefault();
        this.pushEvent && this.pushEvent('keypressed', k, k, e.repeat);
      });
      root.addEventListener('keyup', (e) => {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
        const k = loveKey(e);
        this.pushEvent && this.pushEvent('keyreleased', k, k);
      });
      root.addEventListener('blur', () => { this.touches.clear(); });
      root.addEventListener('paste', (e) => {        // lets the game's "paste seed" read the real clipboard
        const t = e.clipboardData && e.clipboardData.getData('text');
        if (t && this.host && this.host.setClipboardCache) this.host.setClipboardCache(t);
      });
      c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.fail(new Error(root.ATB.ui.T('lost'))); });
      document.addEventListener('visibilitychange', () => {   // silence audio while the tab is hidden
        const a = this.audio;
        if (document.hidden) { if (a.ctx && a.ctx.state === 'running') a.ctx.suspend(); for (const s of a.sources.values()) if (s.el) s.el.pause(); }
        else { if (a.ctx && a.ctx.state === 'suspended') a.ctx.resume(); for (const s of a.sources.values()) if (s.el && s.playing) { const pr = s.el.play(); if (pr && pr.catch) pr.catch(() => {}); } }
      });
    }
  }

  ATB.Runtime = Runtime;
  ATB.detectLanguage = detectLanguage;
})(typeof window !== 'undefined' ? window : globalThis);
