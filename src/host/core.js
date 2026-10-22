/* Core (non-graphics, non-audio) natives shared by the browser and the Node test harness:
 * time, virtual file system (localStorage backed with in-memory fallback), system, require loader. */
(function (root) {
  'use strict';
  const NS = 'atb_balatro_fs:';

  /* ---------------- persistent key/value store (guards against private mode / quota) */
  function makeStore() {
    let ls = null;
    try { ls = root.localStorage; ls.setItem('__atb_probe', '1'); ls.removeItem('__atb_probe'); } catch (e) { ls = null; }
    const mem = new Map();
    if (ls) {
      try {
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k && k.startsWith(NS)) mem.set(k.slice(NS.length), ls.getItem(k));
        }
      } catch (e) { /* ignore */ }
    }
    return {
      persistent: !!ls,
      map: mem,
      get: (k) => mem.get(k),
      degraded: false,
      set(k, v) {
        mem.set(k, v);
        if (ls) {
          try { ls.setItem(NS + k, v); }
          catch (e) {       // quota / blocked: keep playing from memory and tell the player once
            if (!this.degraded) { this.degraded = true; if (root.ATB && root.ATB.ui) root.ATB.ui.toast(root.ATB.ui.T('storage')); }
          }
        }
      },
      remove(k) {
        mem.delete(k);
        if (ls) { try { ls.removeItem(NS + k); } catch (e) { /* ignore */ } }
      },
    };
  }

  function installCore(host, opts) {
    const LUA = root.ATB_LUA;
    const store = root.__atbStore || (root.__atbStore = makeStore());   // shared across Lua restarts
    const dirs = new Set();
    const virtualDirs = new Set(['resources', 'resources/sounds', 'resources/shaders', 'resources/fonts', 'localization', 'engine', 'functions']);
    const FONT_FILES = ['m6x11plus.ttf', 'NotoSansSC-Bold.ttf', 'NotoSansTC-Bold.ttf', 'NotoSansKR-Bold.ttf', 'NotoSansJP-Bold.ttf',
      'NotoSans-Bold.ttf', 'GoNotoCurrent-Bold.ttf', 'GoNotoCJKCore.ttf'];
    const virtualFiles = new Set(Object.keys(LUA.files));
    for (const f of FONT_FILES) virtualFiles.add('resources/fonts/' + f);
    for (const f of LUA.listing['resources/sounds']) virtualFiles.add('resources/sounds/' + f);
    for (const f of LUA.listing['resources/shaders']) virtualFiles.add('resources/shaders/' + f);
    virtualFiles.add('resources/gamecontrollerdb.txt');

    const norm = (p) => p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
    const userHasDir = (p) => {
      if (dirs.has(p)) return true;
      const pre = p + '/';
      for (const k of store.map.keys()) if (k.startsWith(pre)) return true;
      return false;
    };

    /* ---------------- time */
    let last = null;
    const realClock = () => (root.performance ? root.performance.now() : Date.now()) / 1000;
    // __atbSimClock lets the verification driver run the game on a deterministic clock (headless virtual time freezes performance.now)
    const clock = opts.clock || (() => (root.__atbSimClock !== undefined ? root.__atbSimClock : realClock()));
    let fpsFrames = 0, fpsStamp = clock(), fpsValue = 60;
    host.def('now', () => clock());
    host.def('step', () => {
      const t = clock();
      const dt = last === null ? 0 : t - last;
      last = t;
      fpsFrames++;
      if (t - fpsStamp >= 1) { fpsValue = fpsFrames / (t - fpsStamp); fpsFrames = 0; fpsStamp = t; }
      return dt;
    });
    host.def('fps', () => Math.round(fpsValue));
    host.resetTimer = () => { last = null; };      // next step() reports dt = 0 (used after the simulated clock is dropped)

    /* ---------------- file system */
    host.def('fsInfo', (path) => {
      const p = norm(path);
      if (store.map.has(p)) return LuaHostMulti('file', store.map.get(p).length);
      if (virtualFiles.has(p)) return LuaHostMulti('file', (LUA.files[p] || '').length);
      if (virtualDirs.has(p) || userHasDir(p)) return LuaHostMulti('directory', 0);
      return undefined;
    });
    host.def('fsRead', (path) => {
      const p = norm(path);
      if (store.map.has(p)) return store.get(p);
      if (Object.prototype.hasOwnProperty.call(LUA.files, p)) return LUA.files[p];
      return undefined;
    });
    host.def('fsWrite', (path, data, append) => {
      const p = norm(path);
      store.set(p, append ? (store.get(p) || '') + data : data);
    });
    host.def('fsRemove', (path) => {
      const p = norm(path);
      if (store.map.has(p)) { store.remove(p); return true; }
      if (dirs.delete(p)) return true;
      return false;
    });
    host.def('fsMkdir', (path) => { dirs.add(norm(path)); });
    host.def('fsList', (dir) => {
      const p = norm(dir), pre = p ? p + '/' : '';
      const out = new Set();
      const add = (k) => { if (k.startsWith(pre)) { const rest = k.slice(pre.length); const i = rest.indexOf('/'); out.add(i < 0 ? rest : rest.slice(0, i)); } };
      for (const k of store.map.keys()) add(k);
      if (LUA.listing[p]) for (const f of LUA.listing[p]) out.add(f);
      for (const f of FONT_FILES) if (p === 'resources/fonts') out.add(f);
      return Array.from(out);
    });
    host.fsStore = store;
    host.fsNS = NS;

    /* ---------------- system */
    host.def('openURL', (u) => { if (root.open && /^https?:/.test(u)) root.open(u, '_blank', 'noopener'); });
    let clip = '';
    host.def('getClipboard', () => clip);
    host.setClipboardCache = (s) => { clip = s || ''; };   // fed by DOM paste events (the OS clipboard is async-only)
    host.def('setClipboard', (s) => {
      clip = s || '';
      try { if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(clip); } catch (e) { /* ignore */ }
    });
    host.def('quit', () => { if (opts.onQuit) opts.onQuit(); });

    /* ---------------- require loader reading from the bundle */
    host.setGlobalFn('ATB_READ_LUA', (path) => Object.prototype.hasOwnProperty.call(LUA.files, path) ? LUA.files[path] : undefined);
    host.run(`
      arg = {}
      table.insert(package.searchers, 2, function(name)
        local path = name
        if not path:find('/', 1, true) then path = path:gsub('%.', '/') end
        local src = ATB_READ_LUA(path .. '.lua')
        if not src then return '\\n\\tno bundled lua module ' .. name end
        local fn, err = load(src, '@' .. path .. '.lua')
        if not fn then error(err) end
        return fn, path
      end)
      for _, n in ipairs{'audio', 'sound', 'system', 'timer', 'thread', 'filesystem', 'event', 'graphics', 'window', 'mouse', 'math', 'data'} do
        package.preload['love.' .. n] = function() return love[n] or {} end
      end
      package.preload['https'] = function() return {request = function() return 0 end} end
      package.preload['luasteam'] = function() return {} end
    `, 'bootstrap');
  }

  function LuaHostMulti(...v) { return root.ATBLuaHost.multi(...v); }

  root.ATBCore = { installCore };
})(typeof window !== 'undefined' ? window : globalThis);
