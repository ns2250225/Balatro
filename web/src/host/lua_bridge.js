/* Lua <-> JS bridge on top of the patched fengari build.
 * Creates the Lua state, registers native functions under the global `__js`, and
 * provides a `require` that reads from the bundled game sources (window.ATB_LUA). */
(function (root) {
  'use strict';
  const F = root.fengari;
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = F;
  const T = {
    NIL: lua.LUA_TNIL, BOOL: lua.LUA_TBOOLEAN, NUM: lua.LUA_TNUMBER,
    STR: lua.LUA_TSTRING, TABLE: lua.LUA_TTABLE,
  };

  function toJS(L, i, depth) {
    switch (lua.lua_type(L, i)) {
      case T.NIL: return undefined;
      case T.BOOL: return !!lua.lua_toboolean(L, i);
      case T.NUM: return lua.lua_tonumber(L, i);
      case T.STR: return to_jsstring(lua.lua_tostring(L, i));
      case T.TABLE: {
        if ((depth || 0) > 4) return undefined;
        const out = [];
        const n = lua.lua_rawlen(L, i);
        for (let k = 1; k <= n; k++) {
          lua.lua_rawgeti(L, i, k);
          out.push(toJS(L, -1, (depth || 0) + 1));
          lua.lua_pop(L, 1);
        }
        return out;
      }
      default: return undefined;
    }
  }

  function pushJS(L, v) {
    if (v === undefined || v === null) lua.lua_pushnil(L);
    else if (typeof v === 'number') lua.lua_pushnumber(L, v);
    else if (typeof v === 'boolean') lua.lua_pushboolean(L, v);
    else if (typeof v === 'string') lua.lua_pushstring(L, to_luastring(v));
    else if (Array.isArray(v)) {
      lua.lua_createtable(L, v.length, 0);
      for (let k = 0; k < v.length; k++) { pushJS(L, v[k]); lua.lua_rawseti(L, -2, k + 1); }
    } else lua.lua_pushnil(L);
  }

  class LuaHost {
    constructor() {
      this.L = lauxlib.luaL_newstate();
      lualib.luaL_openlibs(this.L);
      this.natives = {};
      lua.lua_createtable(this.L, 0, 64);
      lua.lua_setglobal(this.L, to_luastring('__js'));
    }

    /* Register a native. fn receives the converted Lua arguments.
     * Return a value for one result, or `LuaHost.multi(a, b, ...)` for several. */
    def(name, fn) {
      const L = this.L;
      lua.lua_getglobal(L, to_luastring('__js'));
      lua.lua_pushjsfunction(L, (L2) => {
        const n = lua.lua_gettop(L2);
        const args = new Array(n);
        for (let i = 0; i < n; i++) args[i] = toJS(L2, i + 1);
        let r;
        try { r = fn.apply(null, args); }
        catch (e) {
          lauxlib.luaL_error(L2, to_luastring('js error in ' + name + ': ' + (e && e.stack || e)));
          return 0;
        }
        if (r instanceof Multi) { for (const v of r.values) pushJS(L2, v); return r.values.length; }
        if (r === undefined) return 0;
        pushJS(L2, r);
        return 1;
      });
      lua.lua_setfield(L, -2, to_luastring(name));
      lua.lua_pop(L, 1);
    }

    /* Run a Lua chunk; throws a JS Error with the Lua traceback on failure. */
    run(src, chunkname) {
      const L = this.L;
      const bytes = to_luastring(src);
      if (lauxlib.luaL_loadbuffer(L, bytes, bytes.length, to_luastring('=' + (chunkname || 'chunk'))) !== 0) {
        const msg = to_jsstring(lua.lua_tostring(L, -1)); lua.lua_pop(L, 1);
        throw new Error(msg);
      }
      this._pcall(0, 0);
    }

    /* Call the function on top of the stack (after nargs args) with a traceback handler. */
    _pcall(nargs, nres) {
      const L = this.L;
      const base = lua.lua_gettop(L) - nargs;
      lua.lua_pushjsfunction(L, (L2) => {
        const m = lua.lua_tostring(L2, 1);
        const msg = m ? to_jsstring(m) : '(error object)';
        lauxlib.luaL_traceback(L2, L2, to_luastring(msg), 1);
        return 1;
      });
      lua.lua_insert(L, base);
      const st = lua.lua_pcall(L, nargs, nres, base);
      lua.lua_remove(L, base);
      if (st !== 0) {
        const msg = to_jsstring(lua.lua_tostring(L, -1)); lua.lua_pop(L, 1);
        throw new Error(msg);
      }
    }

    /* Keep a Lua function in the registry; returns a JS callable. */
    ref() {
      return lauxlib.luaL_ref(this.L, lua.LUA_REGISTRYINDEX);
    }
    callRef(ref, ...args) {
      const L = this.L;
      lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
      for (const a of args) pushJS(L, a);
      this._pcall(args.length, 1);
      const r = toJS(L, -1); lua.lua_pop(L, 1);
      return r;
    }
    getGlobalRef(name) {
      lua.lua_getglobal(this.L, to_luastring(name));
      return this.ref();
    }
    setGlobalFn(name, fn) {
      lua.lua_pushjsfunction(this.L, (L2) => {
        const n = lua.lua_gettop(L2); const a = [];
        for (let i = 0; i < n; i++) a.push(toJS(L2, i + 1));
        const r = fn.apply(null, a);
        if (r === undefined) return 0;
        pushJS(L2, r); return 1;
      });
      lua.lua_setglobal(this.L, to_luastring(name));
    }
  }

  class Multi { constructor(values) { this.values = values; } }
  LuaHost.multi = (...values) => new Multi(values);

  root.ATBLuaHost = LuaHost;
})(typeof window !== 'undefined' ? window : globalThis);
