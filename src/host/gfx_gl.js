/* WebGL2 implementation of the LOVE graphics natives used by Balatro.
 * - CPU-side 2D matrix stack, batched triangle submission (8 floats / vertex)
 * - The game's original LOVE .fs shaders are translated to GLSL ES 3.00 and run unchanged
 * - Text is rasterised with Canvas2D into a glyph atlas (see gfx_text.js) */
(function (root) {
  'use strict';

  const MAX_VERTS = 12000;           // flush threshold (vertices)
  const STRIDE = 10;                 // x y u v r g b a lx ly  (lx,ly = pre-transform position for LOVE vertex shaders)

  const VERT_SRC = `#version 300 es
in vec2 aPos; in vec2 aUV; in vec4 aColor; in vec2 aLocal;
uniform vec2 uViewport;
out vec2 vUV; out vec4 vColor;
void main() {
  vUV = aUV; vColor = aColor;
  gl_Position = vec4(aPos.x * 2.0 / uViewport.x - 1.0, 1.0 - aPos.y * 2.0 / uViewport.y, 0.0, 1.0);
}`;

  const FRAG_HEAD = `#version 300 es
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
precision highp int;
precision highp sampler2D;
#define number float
#define Image sampler2D
#define extern uniform
uniform sampler2D MainTex;
uniform vec4 love_ScreenSize;
in vec2 vUV; in vec4 vColor;
out vec4 atb_fragColor;
vec4 atb_texel(sampler2D s, vec2 uv) { return texture(s, uv); }
#define Texel(t, uv) atb_texel(t, uv)
`;
  const FRAG_TAIL = `
void main() {
  vec2 pc = vec2(gl_FragCoord.x, love_ScreenSize.y - gl_FragCoord.y);
  atb_fragColor = effect(vColor, MainTex, vUV, pc);
}`;
  const VERT_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define VERTEX
#define number float
#define Image sampler2D
#define extern uniform
uniform vec4 love_ScreenSize;
uniform mat4 TransformProjectionMatrix;
in vec2 aPos; in vec2 aUV; in vec4 aColor; in vec2 aLocal;
out vec2 vUV; out vec4 vColor;
vec4 atb_texel(sampler2D s, vec2 uv) { return texture(s, uv); }
#define Texel(t, uv) atb_texel(t, uv)
`;
  const VERT_TAIL = `
void main() { vUV = aUV; vColor = aColor; gl_Position = position(TransformProjectionMatrix, vec4(aLocal, 0.0, 1.0)); }`;
  const FRAG_DEFAULT = FRAG_HEAD + `
vec4 effect(vec4 colour, Image tex, vec2 uv, vec2 sc) { return Texel(tex, uv) * colour; }` + FRAG_TAIL;

  class Gfx {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.opts = opts || {};
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;
      this.cssW = 1280; this.cssH = 720; this.dpr = 1;

      // matrix stack: [a b c d e f]
      this.m = [1, 0, 0, 1, 0, 0];
      this.stack = [];
      this.color = [1, 1, 1, 1];
      this.lineWidth = 1;

      this.buf = new Float32Array(MAX_VERTS * STRIDE);
      this.n = 0;                      // vertices queued
      this.curTex = null;
      this.textures = [null];          // handle -> {tex, w, h}
      this.programs = {};              // name -> program record
      this.defaultProg = null;
      this.prog = null;                // active program record
      this.shaderSources = (root.ATB_SHADERS || {});
      this.stats = { draws: 0, verts: 0, glMs: 0 };

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      this.vbo = gl.createBuffer();
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.buf.byteLength, gl.DYNAMIC_DRAW);

      this.white = this._makeTexture(1, 1, new Uint8Array([255, 255, 255, 255]));
      this.defaultProg = this._buildProgram('default', FRAG_DEFAULT);
      this._useProgram(this.defaultProg);
      this.resize(this.cssW, this.cssH, 1);
    }

    /* ------------------------------------------------------------ programs */
    _compile(type, src, label) {
      const gl = this.gl;
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error('shader compile failed (' + label + '): ' + log);
      }
      return sh;
    }

    _buildProgram(name, fragSrc, vertSrc) {
      const gl = this.gl;
      const vs = this._compile(gl.VERTEX_SHADER, vertSrc || VERT_SRC, name + '.vert');
      const fs = this._compile(gl.FRAGMENT_SHADER, fragSrc, name + '.frag');
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aUV'); gl.bindAttribLocation(p, 2, 'aColor'); gl.bindAttribLocation(p, 3, 'aLocal');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program link failed (' + name + '): ' + gl.getProgramInfoLog(p));
      const rec = { name, p, uniforms: {}, customVertex: !!vertSrc, xformLoc: gl.getUniformLocation(p, 'TransformProjectionMatrix'), viewportLoc: gl.getUniformLocation(p, 'uViewport'), screenLoc: gl.getUniformLocation(p, 'love_ScreenSize') };
      const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(p, i);
        const key = info.name.replace(/\[0\]$/, '');
        rec.uniforms[key] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
      }
      return rec;
    }

    /* Translate a LOVE pixel shader (.fs) into a runnable GLSL ES 3.00 fragment shader. */
    _loveToGLSL(src) {
      // vertex-only shaders (vortex, skew) have no pixel `effect`: give them the default one
      const hasEffect = /vec4\s+effect\s*\(/.test(src);
      const fallback = '\nvec4 effect(vec4 colour, Image tex, vec2 uv, vec2 sc) { return Texel(tex, uv) * colour; }\n';
      return FRAG_HEAD + src + (hasEffect ? '' : fallback) + FRAG_TAIL;
    }

    getProgram(name) {
      if (!name) return this.defaultProg;
      let rec = this.programs[name];
      if (rec === undefined) {
        const src = this.shaderSources[name + '.fs'];
        if (!src) { rec = null; } else {
          try {
            const customVertex = /vec4\s+position\s*\(/.test(src) && !/vec4\s+effect\s*\(/.test(src);
            rec = this._buildProgram(name, this._loveToGLSL(src), customVertex ? VERT_HEAD + src + VERT_TAIL : null);
          }
          catch (e) { console.error(e.message); rec = null; }
        }
        this.programs[name] = rec;
      }
      return rec || this.defaultProg;
    }

    _useProgram(rec) {
      const gl = this.gl;
      this.prog = rec;
      gl.useProgram(rec.p);
      gl.uniform2f(rec.viewportLoc, this.cssW, this.cssH);
      if (rec.screenLoc) gl.uniform4f(rec.screenLoc, this.canvas.width, this.canvas.height, 1, 0);
      const t = rec.uniforms.MainTex; if (t) gl.uniform1i(t.loc, 0);
    }

    setShader(name) {
      const rec = this.getProgram(name);
      if (rec === this.prog) return;
      this.flush();
      this._useProgram(rec);
    }

    shaderSend(name, key, v) {
      const rec = this.getProgram(name);
      if (!rec || rec === this.defaultProg) return;
      const u = rec.uniforms[key];
      if (!u) return;
      if (rec === this.prog) this.flush();
      const gl = this.gl;
      gl.useProgram(rec.p);
      const a = Array.isArray(v) ? v : [v];
      const flat = [];
      for (const x of a) { if (Array.isArray(x)) for (const y of x) flat.push(+y); else flat.push(typeof x === 'boolean' ? (x ? 1 : 0) : +x); }
      switch (u.type) {
        case gl.FLOAT: gl.uniform1f(u.loc, flat[0] || 0); break;
        case gl.FLOAT_VEC2: gl.uniform2f(u.loc, flat[0] || 0, flat[1] || 0); break;
        case gl.FLOAT_VEC3: gl.uniform3f(u.loc, flat[0] || 0, flat[1] || 0, flat[2] || 0); break;
        case gl.FLOAT_VEC4: gl.uniform4f(u.loc, flat[0] || 0, flat[1] || 0, flat[2] || 0, flat[3] === undefined ? 1 : flat[3]); break;
        case gl.BOOL: case gl.INT: gl.uniform1i(u.loc, flat[0] ? (typeof a[0] === 'boolean' ? 1 : (flat[0] | 0)) : 0); break;
        case gl.INT_VEC2: gl.uniform2i(u.loc, flat[0] | 0, flat[1] | 0); break;
        default: break;
      }
      if (rec !== this.prog) gl.useProgram(this.prog.p);   // uniforms were set on a non-active program
    }

    /* ------------------------------------------------------------ textures */
    _makeTexture(w, h, pixels) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      this._texParams(gl.LINEAR);
      return { tex, w, h };
    }

    _texParams(filter) {
      const gl = this.gl;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    /* Upload a decoded image; returns handle. */
    addImage(img) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      this._texParams(gl.LINEAR);
      this.textures.push({ tex, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
      this.curTex = null;
      return this.textures.length - 1;
    }

    _bind(rec) {
      if (this.curTex === rec) return;
      this.flush();
      this.gl.bindTexture(this.gl.TEXTURE_2D, rec.tex);
      this.curTex = rec;
    }

    /* ------------------------------------------------------------ frame / viewport */
    resize(cssW, cssH, dpr) {
      this.flush();
      this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
      const c = this.canvas;
      c.width = Math.max(1, Math.round(cssW * dpr)); c.height = Math.max(1, Math.round(cssH * dpr));
      this.gl.viewport(0, 0, c.width, c.height);
      if (this.prog) this._useProgram(this.prog);
    }

    clear(r, g, b, a) {
      this.flush();
      const gl = this.gl;
      gl.clearColor(r, g, b, a);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    flush() {
      if (this.n === 0) return;
      const gl = this.gl;
      if (!this.curTex) { gl.bindTexture(gl.TEXTURE_2D, this.white.tex); this.curTex = this.white; }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.buf, 0, this.n * STRIDE);
      gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1); gl.enableVertexAttribArray(2); gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE * 4, 0);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE * 4, 8);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE * 4, 16);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, STRIDE * 4, 32);
      const t0 = performance.now();
      gl.drawArrays(gl.TRIANGLES, 0, this.n);
      this.stats.draws++; this.stats.verts += this.n; this.stats.glMs += performance.now() - t0;
      this.n = 0;
    }

    /* ------------------------------------------------------------ transform */
    push() { this.stack.push(this.m.slice()); }
    pop() { const m = this.stack.pop(); if (m) this.m = m; }
    origin() { this.m = [1, 0, 0, 1, 0, 0]; }
    translate(x, y) { const m = this.m; y = y || 0; m[4] += m[0] * x + m[2] * y; m[5] += m[1] * x + m[3] * y; }
    scale(x, y) { const m = this.m; if (y === undefined) y = x; m[0] *= x; m[1] *= x; m[2] *= y; m[3] *= y; }
    rotate(r) {
      const m = this.m, c = Math.cos(r), s = Math.sin(r);
      const a = m[0], b = m[1], cc = m[2], d = m[3];
      m[0] = a * c + cc * s; m[1] = b * c + d * s; m[2] = -a * s + cc * c; m[3] = -b * s + d * c;
    }
    setColor(r, g, b, a) { const c = this.color; c[0] = r; c[1] = g; c[2] = b; c[3] = a === undefined ? 1 : a; }
    setLineWidth(w) { this.lineWidth = w; }

    /* ------------------------------------------------------------ vertex emission */
    _v(x, y, u, v, lx, ly) {   // x,y already in world (css px) space
      if (this.n >= MAX_VERTS) this.flush();
      const b = this.buf, o = this.n * STRIDE, c = this.color;
      b[o] = x; b[o + 1] = y; b[o + 2] = u; b[o + 3] = v; b[o + 4] = c[0]; b[o + 5] = c[1]; b[o + 6] = c[2]; b[o + 7] = c[3];
      b[o + 8] = lx || 0; b[o + 9] = ly || 0;
      this.n++;
    }
    _tri(x1, y1, x2, y2, x3, y3) {   // local coords, solid colour
      this._bind(this.white);
      const m = this.m;
      this._v(m[0] * x1 + m[2] * y1 + m[4], m[1] * x1 + m[3] * y1 + m[5], 0.5, 0.5);
      this._v(m[0] * x2 + m[2] * y2 + m[4], m[1] * x2 + m[3] * y2 + m[5], 0.5, 0.5);
      this._v(m[0] * x3 + m[2] * y3 + m[4], m[1] * x3 + m[3] * y3 + m[5], 0.5, 0.5);
    }
    _quad(x, y, w, h) {
      this._tri(x, y, x + w, y, x + w, y + h);
      this._tri(x, y, x + w, y + h, x, y + h);
    }

    /* Fill a convex polygon given [x1,y1,x2,y2,...] */
    _fillPoly(pts) {
      const n = pts.length / 2;
      for (let i = 1; i < n - 1; i++) this._tri(pts[0], pts[1], pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3]);
    }

    /* Thick polyline with bevel joins. */
    _strokePoly(pts, closed) {
      const n = pts.length / 2;
      if (n < 2) return;
      const hw = this.lineWidth / 2;
      const segs = closed ? n : n - 1;
      let prev = null;
      for (let i = 0; i < segs; i++) {
        const x1 = pts[2 * i], y1 = pts[2 * i + 1];
        const j = (i + 1) % n;
        const x2 = pts[2 * j], y2 = pts[2 * j + 1];
        let dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        dx /= len; dy /= len;
        const nx = -dy * hw, ny = dx * hw;
        this._tri(x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny);
        this._tri(x1 + nx, y1 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny);
        if (prev) {            // fill the outer gap at the joint with a small fan on both sides
          this._tri(x1, y1, x1 + prev.nx, y1 + prev.ny, x1 + nx, y1 + ny);
          this._tri(x1, y1, x1 - prev.nx, y1 - prev.ny, x1 - nx, y1 - ny);
        }
        prev = { nx, ny };
        if (closed && i === segs - 1) {   // close joint with the first segment
          const k = 1 % n; let ex = pts[2 * k] - pts[0], ey = pts[2 * k + 1] - pts[1];
          const el = Math.hypot(ex, ey) || 1; ex /= el; ey /= el;
          const fx = -ey * hw, fy = ex * hw;
          this._tri(pts[0], pts[1], pts[0] + nx, pts[1] + ny, pts[0] + fx, pts[1] + fy);
          this._tri(pts[0], pts[1], pts[0] - nx, pts[1] - ny, pts[0] - fx, pts[1] - fy);
        }
      }
    }

    _roundedRectPts(x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      const steps = Math.max(3, Math.min(10, Math.ceil(r * 0.8)));
      const pts = [];
      const arc = (cx, cy, a0) => { for (let i = 0; i <= steps; i++) { const a = a0 + (Math.PI / 2) * (i / steps); pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } };
      arc(x + w - r, y + r, -Math.PI / 2);
      arc(x + w - r, y + h - r, 0);
      arc(x + r, y + h - r, Math.PI / 2);
      arc(x + r, y + r, Math.PI);
      return pts;
    }

    /* ------------------------------------------------------------ primitives */
    rect(fill, x, y, w, h, rx) {
      if (rx > 0) {
        const pts = this._roundedRectPts(x, y, w, h, rx);
        if (fill) this._fillPoly(pts); else this._strokePoly(pts, true);
      } else if (fill) this._quad(x, y, w, h);
      else this._strokePoly([x, y, x + w, y, x + w, y + h, x, y + h], true);
    }
    circle(fill, x, y, r) {
      const steps = Math.max(8, Math.min(48, Math.ceil(r * 1.5)));
      const pts = [];
      for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI * 2; pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r); }
      if (fill) this._fillPoly(pts); else this._strokePoly(pts, true);
    }
    polygon(fill, pts) { if (fill) this._fillPoly(pts); else this._strokePoly(pts, true); }
    polyline(pts) { this._strokePoly(pts, false); }

    /* Textured quad. (qx,qy,qw,qh) in logical units, texture dpiscale `dpi`. */
    drawImage(handle, dpi, qx, qy, qw, qh, x, y, r, sx, sy, ox, oy) {
      const rec = this.textures[handle];
      if (!rec) return;
      this._bind(rec);
      const iw = 1 / rec.w, ih = 1 / rec.h;
      const u0 = qx * dpi * iw, v0 = qy * dpi * ih, u1 = (qx + qw) * dpi * iw, v1 = (qy + qh) * dpi * ih;
      this._texQuad(u0, v0, u1, v1, qw, qh, x, y, r, sx, sy, ox, oy);
    }

    _texQuad(u0, v0, u1, v1, w, h, x, y, r, sx, sy, ox, oy) {
      const m = this.m;
      // local -> world: M * T(x,y) * R(r) * S(sx,sy) * T(-ox,-oy)
      const c = Math.cos(r), s = Math.sin(r);
      const a = (m[0] * c + m[2] * s) * sx, b = (m[1] * c + m[3] * s) * sx;
      const cc = (-m[0] * s + m[2] * c) * sy, d = (-m[1] * s + m[3] * c) * sy;
      const e = m[0] * x + m[2] * y + m[4], f = m[1] * x + m[3] * y + m[5];
      const x0 = -ox, y0 = -oy, x1 = w - ox, y1 = h - oy;
      const px = (lx, ly) => a * lx + cc * ly + e, py = (lx, ly) => b * lx + d * ly + f;
      const p00x = px(x0, y0), p00y = py(x0, y0), p10x = px(x1, y0), p10y = py(x1, y0);
      const p11x = px(x1, y1), p11y = py(x1, y1), p01x = px(x0, y1), p01y = py(x0, y1);
      const custom = this.prog.customVertex;
      if (custom) {          // LOVE vertex shaders see raw quad coordinates + the full transform (no CPU batching)
        this.flush();
        const W = this.cssW, H = this.cssH;
        const ee = e - a * ox - cc * oy, ff = f - b * ox - d * oy;
        this.gl.uniformMatrix4fv(this.prog.xformLoc, false, new Float32Array([a * 2 / W, -b * 2 / H, 0, 0, cc * 2 / W, -d * 2 / H, 0, 0, 0, 0, 1, 0, ee * 2 / W - 1, 1 - ff * 2 / H, 0, 1]));
      }
      this._v(p00x, p00y, u0, v0, 0, 0); this._v(p10x, p10y, u1, v0, w, 0); this._v(p11x, p11y, u1, v1, w, h);
      this._v(p00x, p00y, u0, v0, 0, 0); this._v(p11x, p11y, u1, v1, w, h); this._v(p01x, p01y, u0, v1, 0, h);
      if (custom) this.flush();
    }
  }

  root.ATBGfx = Gfx;
})(typeof window !== 'undefined' ? window : globalThis);
