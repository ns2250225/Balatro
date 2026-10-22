/* Dual-mode audio engine for the LOVE `Source` natives.
 *  - HTTP(S): SFX are fetched, decoded once, and played through Web Audio (polyphonic, pitch via playbackRate)
 *  - file:// (fetch blocked) or decode failure: pooled HTMLAudioElement fallback so the game is never silent
 *  - Music (the five `music*` tracks) streams through HTMLAudioElement; because the original game plays all
 *    five tracks together and crossfades by volume, silent tracks are started lazily at the shared music
 *    clock position so they stay in sync.
 *  - Loading is lazy; a throttled (<=3 concurrent) background queue warms the SFX cache after first gesture. */
(function (root) {
  'use strict';

  const BASE = 'assets/sounds/';
  const MAX_ELEMENTS = 24;

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.sources = new Map();
      this.nextId = 1;
      this.buffers = new Map();       // name -> AudioBuffer | 'loading' | 'failed'
      this.waiters = new Map();       // name -> [fn]
      this.queue = [];
      this.active = 0;
      this.unlocked = false;
      this.masterGain = null;
      this.elements = [];             // live sfx <audio> clones
      this.musicClock = null;
      // fetch works over http(s), and under file:// when the standalone VFS shim serves the sounds from memory
      this.canFetch = (typeof location !== 'undefined' && /^https?:/.test(location.protocol)) || !!(typeof window !== 'undefined' && window.__ATB_VFS__);
      this.ext = '.ogg';
      try {
        const a = new Audio();
        if (!a.canPlayType('audio/ogg; codecs="vorbis"')) this.ext = '.m4a';
      } catch (e) { /* no audio at all */ }
      this._bindUnlock();
    }

    _bindUnlock() {
      if (typeof window === 'undefined') return;
      const go = () => {
        this.unlock();
        for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.removeEventListener(ev, go, true);
      };
      for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.addEventListener(ev, go, true);
    }

    unlock() {
      if (this.unlocked) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          this.ctx = new AC();
          this.masterGain = this.ctx.createGain();
          this.masterGain.connect(this.ctx.destination);
          if (this.ctx.state === 'suspended') this.ctx.resume();
        }
      } catch (e) { this.ctx = null; }
      this.unlocked = true;
      // start any music that was waiting for a gesture
      for (const s of this.sources.values()) if (s.stream && s.playing) this._startMusic(s);
      this._warm();
    }

    _warm() {      // throttled background decode of every SFX so first triggers are instant
      if (!this.ctx || !this.canFetch || !root.ATB_DATA) return;
      for (const n of root.ATB_DATA.sounds) if (!/^music/.test(n) && !/^ambient/.test(n)) this.queue.push(n);
      this._pump();
    }
    _pump() {
      while (this.active < 3 && this.queue.length) {
        const n = this.queue.shift();
        if (this.buffers.has(n)) continue;
        this.active++;
        this._load(n, () => { this.active--; this._pump(); });
      }
    }

    _load(name, done) {
      if (this.buffers.has(name)) { if (done) done(); return; }
      if (!this.ctx || !this.canFetch) { this.buffers.set(name, 'failed'); if (done) done(); return; }
      this.buffers.set(name, 'loading');
      fetch(BASE + name + this.ext).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then((ab) => new Promise((res, rej) => this.ctx.decodeAudioData(ab, res, rej)))
        .then((buf) => { this.buffers.set(name, buf); this._fire(name); })
        .catch(() => { this.buffers.set(name, 'failed'); this._fire(name); })
        .then(() => { if (done) done(); });
    }
    _fire(name) { const w = this.waiters.get(name); if (w) { this.waiters.delete(name); for (const f of w) f(); } }

    /* ---------------------------------------------------------- Source API */
    srcNew(name, stream) {
      const id = this.nextId++;
      this.sources.set(id, { id, name, stream: !!(stream && /^(music|ambient)/.test(name)), vol: 1, pitch: 1, loop: false, playing: false, node: null, gain: null, el: null, startedAt: 0 });
      return id;
    }

    srcPlay(id) {
      const s = this.sources.get(id); if (!s) return;
      if (s.vol <= 0 && !s.stream) return;          // the original pre-warms every sound silently; skip that work
      if (s.stream) { s.playing = true; if (s.vol > 0.001) this._startMusic(s); return; }
      s.playing = true;
      this._playSfx(s);
    }

    _playSfx(s) {
      const buf = this.buffers.get(s.name);
      if (buf && buf !== 'loading' && buf !== 'failed' && this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const node = this.ctx.createBufferSource();
        node.buffer = buf;
        node.playbackRate.value = s.pitch;
        node.loop = s.loop;
        const gain = this.ctx.createGain();
        gain.gain.value = s.vol;
        node.connect(gain); gain.connect(this.masterGain);
        node.onended = () => { if (s.node === node) { s.playing = false; s.node = null; } };
        s.node = node; s.gain = gain;
        node.start();
      } else if (buf === 'loading') {
        const w = this.waiters.get(s.name) || []; w.push(() => { if (s.playing && !s.node) this._playSfx(s); }); this.waiters.set(s.name, w);
        s.playing = true;
      } else if (buf === 'failed' || !this.ctx) {
        this._playElement(s);
      } else {
        this._load(s.name, () => { if (s.playing && !s.node && !s.el) this._playSfx(s); });
      }
    }

    _playElement(s) {
      if (this.elements.length >= MAX_ELEMENTS) { s.playing = false; return; }
      let el;
      try { el = new Audio(BASE + s.name + this.ext); } catch (e) { s.playing = false; return; }
      el.volume = Math.min(1, s.vol); el.preservesPitch = false; el.playbackRate = Math.max(0.0625, Math.min(16, s.pitch));
      s.el = el; this.elements.push(el);
      const end = () => { s.playing = false; s.el = null; const i = this.elements.indexOf(el); if (i >= 0) this.elements.splice(i, 1); };
      el.addEventListener('ended', end); el.addEventListener('error', end);
      const p = el.play(); if (p && p.catch) p.catch(end);
    }

    _startMusic(s) {
      if (!this.unlocked) return;                    // browsers block audio before the first gesture; retried by unlock()
      if (s.el) { if (s.el.paused) { const p = s.el.play(); if (p && p.catch) p.catch(() => {}); } return; }
      const el = new Audio(BASE + s.name + this.ext);
      el.loop = true; el.preservesPitch = false; el.volume = Math.min(1, s.vol); el.playbackRate = Math.max(0.0625, Math.min(16, s.pitch));
      s.el = el;
      if (this.musicClock === null) this.musicClock = performance.now() / 1000;
      const sync = () => {
        const d = el.duration;
        if (d && isFinite(d)) { try { el.currentTime = ((performance.now() / 1000 - this.musicClock) % d + d) % d; } catch (e) { /* ignore */ } }
        const p = el.play(); if (p && p.catch) p.catch(() => {});
      };
      if (el.readyState >= 1) sync(); else el.addEventListener('loadedmetadata', sync, { once: true });
    }

    srcStop(id) {
      const s = this.sources.get(id); if (!s) return;
      s.playing = false;
      if (s.node) { try { s.node.onended = null; s.node.stop(); } catch (e) { /* already stopped */ } s.node = null; }
      if (s.el) { try { s.el.pause(); } catch (e) { /* ignore */ } const i = this.elements.indexOf(s.el); if (i >= 0) this.elements.splice(i, 1); s.el = null; }
    }

    srcIsPlaying(id) { const s = this.sources.get(id); return !!(s && s.playing); }

    srcVolume(id, v) {
      const s = this.sources.get(id); if (!s) return;
      s.vol = v;
      if (s.gain) s.gain.gain.value = v;
      if (s.el) s.el.volume = Math.max(0, Math.min(1, v));
      if (s.stream && s.playing && v > 0.001 && !s.el) this._startMusic(s);
    }

    srcPitch(id, p) {
      const s = this.sources.get(id); if (!s) return;
      s.pitch = p;
      if (s.node) s.node.playbackRate.value = p;
      if (s.el) s.el.playbackRate = Math.max(0.0625, Math.min(16, p));
    }

    srcLoop(id, l) { const s = this.sources.get(id); if (s) { s.loop = l; if (s.node) s.node.loop = l; } }
    srcRelease(id) { this.srcStop(id); this.sources.delete(id); }
    srcStopAll() { for (const id of Array.from(this.sources.keys())) this.srcStop(id); }
  }

  root.ATBAudioEngine = AudioEngine;
})(typeof window !== 'undefined' ? window : globalThis);
