/* Canvas2D fallback renderer (no WebGL2 / blocked GPU): same interface as ATBGfx.
 * Shaders are emulated for the effects that matter most: card shadows, dissolve fading, and the animated
 * background colours. Everything else draws unshaded, so the game stays playable instead of going black. */
(function (root) {
  'use strict';

  class Gfx2D {
    constructor(canvas) {
      this.canvas = canvas;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Canvas2D is not available');
      this.ctx = ctx;
      this.cssW = 1280; this.cssH = 720; this.dpr = 1;
      this.images = [null];
      this.color = [1, 1, 1, 1];
      this.shader = null;
      this.uniforms = {};
      this.silhouettes = new Map();
      this.stats = { draws: 0, verts: 0, glMs: 0 };
      this.fallback = true;
      this.resize(this.cssW, this.cssH, 1);
    }

    resize(w, h, dpr) {
      this.cssW = w; this.cssH = h; this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(w * dpr)); this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.imageSmoothingEnabled = true;
    }

    flush() {}
    addImage(img) { this.images.push(img); return this.images.length - 1; }

    _rgba(c, aMul) { return 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ',' + (c[3] * (aMul === undefined ? 1 : aMul)) + ')'; }
    setColor(r, g, b, a) { const c = this.color; c[0] = r; c[1] = g; c[2] = b; c[3] = a === undefined ? 1 : a; }
    setLineWidth(w) { this.ctx.lineWidth = w; }
    push() { this.ctx.save(); }
    pop() { this.ctx.restore(); }
    origin() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
    translate(x, y) { this.ctx.translate(x, y || 0); }
    scale(x, y) { this.ctx.scale(x, y === undefined ? x : y); }
    rotate(r) { this.ctx.rotate(r); }

    clear(r, g, b, a) {
      const ctx = this.ctx;
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = this._rgba([r, g, b, a]); ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.restore();
    }

    setShader(name) { this.shader = name; }
    shaderSend(name, key, v) { (this.uniforms[name] || (this.uniforms[name] = {}))[key] = v; }

    _path(fill, build) {
      const ctx = this.ctx;
      ctx.beginPath(); build(ctx);
      if (fill) { ctx.fillStyle = this._rgba(this.color); ctx.fill(); }
      else { ctx.strokeStyle = this._rgba(this.color); ctx.stroke(); }
    }

    rect(fill, x, y, w, h, rx) {
      const ctx = this.ctx;
      if (fill && this.shader === 'background') {       // the swirling background: approximate with its palette
        const u = this.uniforms.background || {};
        const c1 = u.colour_1 || [0.3, 0.4, 0.4, 1], c2 = u.colour_2 || [0.15, 0.2, 0.22, 1];
        const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
        g.addColorStop(0, this._rgba(c1)); g.addColorStop(1, this._rgba(c2));
        ctx.fillStyle = g; ctx.fillRect(x, y, w, h); return;
      }
      this._path(fill, (c) => { if (rx > 0 && c.roundRect) c.roundRect(x, y, w, h, Math.min(rx, w / 2, h / 2)); else c.rect(x, y, w, h); });
    }
    circle(fill, x, y, r) { this._path(fill, (c) => c.arc(x, y, r, 0, Math.PI * 2)); }
    polygon(fill, pts) { this._path(fill, (c) => { c.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); c.closePath(); }); }
    polyline(pts) { this._path(false, (c) => { c.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); }); }

    _silhouette(handle, sx, sy, sw, sh) {
      const key = handle + ':' + sx + ':' + sy + ':' + sw + ':' + sh;
      let c = this.silhouettes.get(key);
      if (!c) {
        c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(sw)); c.height = Math.max(1, Math.ceil(sh));
        const x = c.getContext('2d');
        x.drawImage(this.images[handle], sx, sy, sw, sh, 0, 0, sw, sh);
        x.globalCompositeOperation = 'source-in'; x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
        this.silhouettes.set(key, c);
      }
      return c;
    }

    drawImage(handle, dpi, qx, qy, qw, qh, x, y, r, sx, sy, ox, oy) {
      const img = this.images[handle]; if (!img) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(x, y); if (r) ctx.rotate(r); ctx.scale(sx, sy); ctx.translate(-ox, -oy);
      const u = this.uniforms[this.shader] || {};
      let alpha = this.color[3], src = img;
      const px = qx * dpi, py = qy * dpi, pw = qw * dpi, ph = qh * dpi;
      if (this.shader === 'dissolve' || this.shader === null || this.shader === undefined) {
        if (u.shadow && this.shader === 'dissolve') { src = this._silhouette(handle, px, py, pw, ph); alpha *= 0.3; ctx.globalAlpha = alpha; ctx.drawImage(src, 0, 0, pw, ph, 0, 0, qw, qh); ctx.restore(); return; }
        if (typeof u.dissolve === 'number' && u.dissolve > 0.001) alpha *= Math.max(0, 1 - u.dissolve);
      }
      ctx.globalAlpha = alpha;
      ctx.drawImage(src, px, py, pw, ph, 0, 0, qw, qh);
      ctx.restore();
    }
  }

  class Text2D extends root.ATBTextRenderer {
    drawText(fid, parts, x, y, r, sx, sy, ox, oy) {
      const g = this.gfx, ctx = g.ctx, f = this.fonts[fid];
      this._metrics(f);
      ctx.save();
      ctx.translate(x, y); if (r) ctx.rotate(r); ctx.scale(sx, sy); ctx.translate(-ox, -oy);
      ctx.font = this._font(f, f.raster); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      ctx.scale(1 / f.raster, 1 / f.raster);
      let px = 0;
      for (const p of parts) {
        const c = p[0];
        const col = c ? [c[0] * g.color[0], c[1] * g.color[1], c[2] * g.color[2], (c[3] === undefined ? 1 : c[3]) * g.color[3]] : g.color;
        ctx.fillStyle = g._rgba(col);
        ctx.fillText(p[1], px, f.ascent * f.raster);
        px += ctx.measureText(p[1]).width;
      }
      ctx.restore();
    }
  }

  root.ATBGfx2D = Gfx2D;
  root.ATBText2D = Text2D;
})(typeof window !== 'undefined' ? window : globalThis);
