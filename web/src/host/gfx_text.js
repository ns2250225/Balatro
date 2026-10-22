/* Font metrics and text rasterisation for the WebGL backend.
 * Text objects are rendered once with Canvas2D into shared atlas pages and drawn as textured quads. */
(function (root) {
  'use strict';

  const PAGE = 2048;
  const RASTER_TARGET = 72;     // desired glyph raster size in px (game fonts are huge: 140-200px)
  const MAX_PAGES = 4;

  const FAMILIES = {
    'm6x11plus.ttf': { css: '"ATBm6x11plus", monospace', bold: false, metrics: { ascent: 0.75, descent: 0.25 } },
    'NotoSansSC-Bold.ttf': { css: '"ATBNotoSC", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", sans-serif', bold: true },
    'NotoSansTC-Bold.ttf': { css: '"ATBNotoTC", "Microsoft JhengHei", "PingFang TC", "Noto Sans CJK TC", "Noto Sans TC", sans-serif', bold: true },
    'NotoSansKR-Bold.ttf': { css: '"ATBNotoKR", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR", "Noto Sans KR", sans-serif', bold: true },
    'NotoSansJP-Bold.ttf': { css: '"ATBNotoJP", "Yu Gothic", "Meiryo", "Hiragino Sans", "Noto Sans CJK JP", "Noto Sans JP", sans-serif', bold: true },
    'NotoSans-Bold.ttf': { css: '"Noto Sans", "Segoe UI", Arial, sans-serif', bold: true },
    'GoNotoCurrent-Bold.ttf': { css: '"Noto Sans", "Segoe UI", Arial, sans-serif', bold: true },
    'GoNotoCJKCore.ttf': { css: '"Microsoft YaHei", "Noto Sans CJK SC", sans-serif', bold: false },
  };

  class TextRenderer {
    constructor(gfx) {
      this.gfx = gfx;
      this.fonts = [null];
      this.widthCache = new Map();
      const c = document.createElement('canvas'); c.width = c.height = 8;
      this.mctx = c.getContext('2d');
      this.entries = new Map();       // key -> {page, u0,v0,u1,v1, w, h}
      this.pages = [];                // {rec, x, y, rowH, keys:Set}
      this.curPage = -1;
      this.scratch = document.createElement('canvas');
      this.sctx = this.scratch.getContext('2d', { willReadFrequently: false });
    }

    newFont(file, size) {
      const base = (file || 'm6x11plus.ttf').split('/').pop();
      const fam = FAMILIES[base] || FAMILIES['m6x11plus.ttf'];
      const f = { size, css: fam.css, bold: fam.bold, fixed: fam.metrics || null, raster: Math.min(1, RASTER_TARGET / size) };
      this.fonts.push(f);
      return this.fonts.length - 1;
    }

    _font(f, scale) { return (f.bold ? 'bold ' : '') + (f.size * scale) + 'px ' + f.css; }

    _metrics(f) {
      if (f.ascent === undefined) {
        if (f.fixed) { f.ascent = f.fixed.ascent * f.size; f.height = (f.fixed.ascent + f.fixed.descent) * f.size; }
        else {
          this.mctx.font = this._font(f, 1);
          const m = this.mctx.measureText('Mgy');
          f.ascent = m.fontBoundingBoxAscent || f.size * 0.9;
          f.height = f.ascent + (m.fontBoundingBoxDescent || f.size * 0.25);
        }
      }
    }
    fontHeight(id) { const f = this.fonts[id]; this._metrics(f); return f.height; }
    fontAscent(id) { const f = this.fonts[id]; this._metrics(f); return f.ascent; }

    textWidth(id, s) {
      const f = this.fonts[id];
      const key = id + '\u0001' + s;
      let w = this.widthCache.get(key);
      if (w === undefined) {
        // measure at the raster size to avoid huge font sizes, then scale back
        this.mctx.font = this._font(f, f.raster);
        w = this.mctx.measureText(s).width / f.raster;
        if (this.widthCache.size > 20000) this.widthCache.clear();
        this.widthCache.set(key, w);
      }
      return w;
    }

    _newPage() {
      const gfx = this.gfx, gl = gfx.gl;
      if (this.pages.length >= MAX_PAGES) {      // recycle the oldest page; its entries are dropped
        this.curPage = (this.curPage + 1) % this.pages.length;
        const pg = this.pages[this.curPage];
        for (const k of pg.keys) this.entries.delete(k);
        pg.keys.clear(); pg.x = 0; pg.y = 0; pg.rowH = 0;
        return pg;
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PAGE, PAGE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gfx._texParams(gl.LINEAR);
      gfx.curTex = null;
      const pg = { rec: { tex, w: PAGE, h: PAGE }, x: 0, y: 0, rowH: 0, keys: new Set() };
      this.pages.push(pg); this.curPage = this.pages.length - 1;
      return pg;
    }

    _alloc(w, h) {
      let pg = this.curPage >= 0 ? this.pages[this.curPage] : this._newPage();
      if (pg.x + w > PAGE) { pg.x = 0; pg.y += pg.rowH; pg.rowH = 0; }
      if (pg.y + h > PAGE) { pg = this._newPage(); }
      const pos = { pg, x: pg.x, y: pg.y };
      pg.x += w; pg.rowH = Math.max(pg.rowH, h);
      return pos;
    }

    /* parts: [[color|false, str], ...] */
    _raster(fid, parts, key) {
      const f = this.fonts[fid]; this._metrics(f);
      let scale = f.raster;
      let total = 0;
      for (const p of parts) total += this.textWidth(fid, p[1]);
      let wpx = Math.ceil(total * scale) + 4, hpx = Math.ceil(f.height * scale) + 4;
      if (wpx > PAGE - 2) { scale *= (PAGE - 8) / wpx; wpx = PAGE - 4; hpx = Math.ceil(f.height * scale) + 4; }
      if (hpx > PAGE - 2) return null;
      const sc = this.scratch, ctx = this.sctx;
      sc.width = wpx; sc.height = hpx;
      ctx.clearRect(0, 0, wpx, hpx);
      ctx.font = this._font(f, scale);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      let x = 2;
      for (const p of parts) {
        const c = p[0];
        ctx.fillStyle = c ? 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ',' + (c[3] === undefined ? 1 : c[3]) + ')' : '#fff';
        ctx.fillText(p[1], x, 2 + f.ascent * scale);
        x += ctx.measureText(p[1]).width;
      }
      const pos = this._alloc(wpx, hpx);
      const gl = this.gfx.gl;
      gl.bindTexture(gl.TEXTURE_2D, pos.pg.rec.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, pos.x, pos.y, gl.RGBA, gl.UNSIGNED_BYTE, sc);
      this.gfx.curTex = null;
      const e = {
        rec: pos.pg.rec, u0: (pos.x + 2) / PAGE, v0: (pos.y + 2) / PAGE,
        u1: (pos.x + 2 + total * scale) / PAGE, v1: (pos.y + 2 + f.height * scale) / PAGE,
        w: total, h: f.height,
      };
      pos.pg.keys.add(key);
      this.entries.set(key, e);
      return e;
    }

    drawText(fid, parts, x, y, r, sx, sy, ox, oy, cr, cg, cb, ca) {
      if (!parts || !parts.length) return;
      let key = fid + '\u0001';
      for (const p of parts) key += (p[0] ? p[0][0] + ',' + p[0][1] + ',' + p[0][2] + ',' + p[0][3] : '') + '\u0002' + p[1] + '\u0003';
      let e = this.entries.get(key);
      if (!e) {
        let any = false; for (const p of parts) if (p[1]) any = true;
        if (!any) return;
        e = this._raster(fid, parts, key);
        if (!e) return;
      }
      const gfx = this.gfx;
      gfx._bind(e.rec);
      gfx._texQuad(e.u0, e.v0, e.u1, e.v1, e.w, e.h, x, y, r, sx, sy, ox, oy);
    }
  }

  root.ATBTextRenderer = TextRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
