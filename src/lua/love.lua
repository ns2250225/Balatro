-- ATB web runtime: a LOVE 11.x API shim running on fengari (Lua in JS).
-- Native work is delegated to JS through the `__js` table registered by love_host.js.
local J = __js

-------------------------------------------------------------------------------
-- LuaJIT / 5.1 compatibility
-------------------------------------------------------------------------------
unpack = unpack or table.unpack
loadstring = loadstring or load
-- fengari iterates table entries in hash-chain order, so pairs() over a Lua
-- array is NOT in index order (a 3-element array comes out reversed). LuaJIT,
-- which the original game targets, walks the array part in index order - UI
-- layouts (UIBox:set_parent_child), scoring loops and event queues depend on
-- it. Override pairs to iterate exact arrays 1..n in order; every other table
-- keeps the engine's iteration order. __pairs metamethods still win. Arrays
-- that shrink DURING iteration are handled by skipping nil slots (see below).
do
  local _pairs, _next, _type, _rawget = pairs, next, type, rawget
  local _rawlen = rawlen or function(t) return #t end
  local _getmeta = getmetatable
  pairs = function(t, ...)
    if _type(t) ~= 'table' then return _pairs(t, ...) end
    local mt = _getmeta(t)
    if mt and mt.__pairs then return _pairs(t, ...) end
    local n = _rawlen(t)
    if n < 1 then return _pairs(t, ...) end
    -- only take over when the table is an exact array (keys are 1..n, no holes, no extra keys)
    local is_array, seen, k = true, 0, _next(t)
    while k do
      if _type(k) == 'number' and k % 1 == 0 and k >= 1 and k <= n then seen = seen + 1
      else is_array = false break end
      k = _next(t, k)
    end
    if not is_array or seen ~= n then return _pairs(t, ...) end
    local i = 0
    return function(tt)
      -- Slots can legitimately become nil mid-iteration: game code calls
      -- table.remove(G.MOVEABLES, k) from inside the update loop (Card:update
      -- dropping its focused_ui / alert UIBoxes, e.g. after skipping a blind).
      -- next() never yields nil values - a nil slot is simply not a key - so
      -- skip holes instead of handing nil to the caller (which would be an
      -- "attempt to index a nil value" crash at the call site).
      while i < n do
        i = i + 1
        local v = _rawget(tt, i)
        if v ~= nil then return i, v end
      end
    end, t, nil
  end
end
math.pow = math.pow or function(a, b) return a ^ b end
math.mod = math.mod or math.fmod
math.log10 = math.log10 or function(x) return math.log(x, 10) end
math.atan2 = math.atan2 or function(y, x) return math.atan(y, x) end
math.cosh = math.cosh or function(x) return (math.exp(x) + math.exp(-x)) / 2 end
math.sinh = math.sinh or function(x) return (math.exp(x) - math.exp(-x)) / 2 end
math.tanh = math.tanh or function(x) local a, b = math.exp(x), math.exp(-x); return (a - b) / (a + b) end
math.ldexp = math.ldexp or function(m, e) return m * 2 ^ e end
string.gfind = string.gfind or string.gmatch
table.maxn = table.maxn or function(t) local n = 0 for k in pairs(t) do if type(k) == 'number' and k > n then n = k end end return n end
table.getn = table.getn or function(t) return #t end
-- fengari has no incremental GC control; the game only uses it for tuning
collectgarbage = function(opt) if opt == 'count' then return 0, 0 end return 0 end
local _print = print
print = function(...) local a = ...; if type(a) == 'string' and a:sub(1, 7) == 'LONG DT' then return end return _print(...) end
-- Lua 5.1 table.remove ignores out-of-range positions (5.3 raises); the game relies on that in remove_all()
do
  local _remove, _insert = table.remove, table.insert
  table.remove = function(t, pos)
    local n = #t
    if pos == nil then pos = n end
    if n == 0 and pos == 0 then return nil end
    if pos < 1 or pos > n then return nil end
    return _remove(t, pos)
  end
  table.insert = function(t, a, b)
    if b == nil then return _insert(t, a) end
    local n = #t
    if a < 1 or a > n + 1 then return end   -- 5.1 does not raise either
    return _insert(t, a, b)
  end
end
jit = {arch = 'web', os = 'Web', off = function() end, flush = function() end}

local function toint32(n) n = math.floor(n) % 4294967296; if n >= 2147483648 then n = n - 4294967296 end; return n end
package.preload['bit'] = function()
  local bit = {}
  function bit.tobit(a) return toint32(a) end
  function bit.bxor(a, b) return toint32(math.floor(a) ~ math.floor(b)) end
  function bit.band(a, b) return toint32(math.floor(a) & math.floor(b)) end
  function bit.bor(a, b) return toint32(math.floor(a) | math.floor(b)) end
  function bit.bnot(a) return toint32(~math.floor(a)) end
  function bit.lshift(a, n) return toint32((math.floor(a) % 4294967296) << (n % 32)) end
  function bit.rshift(a, n) return toint32((math.floor(a) % 4294967296) >> (n % 32)) end
  return bit
end

-------------------------------------------------------------------------------
-- love table
-------------------------------------------------------------------------------
love = {}
love.handlers = {}
local love_event_queue = {}

love.arg = {parseGameArguments = function() return {} end}

----------------------------------------------------------------- timer
love.timer = {}
function love.timer.getTime() return J.now() end
function love.timer.step() return J.step() end
function love.timer.getFPS() return J.fps() end
function love.timer.sleep() end

----------------------------------------------------------------- system
love.system = {}
function love.system.getOS() return 'Web' end
function love.system.openURL(url) J.openURL(url) end
function love.system.getClipboardText() return J.getClipboard() end
function love.system.setClipboardText(s) J.setClipboard(s) end

----------------------------------------------------------------- event
love.event = {}
function love.event.pump() end
function love.event.push(name, ...) love_event_queue[#love_event_queue + 1] = {name, ...} end
function love.event.quit() J.quit() end
function love.event.poll()
  local i = 0
  return function()
    i = i + 1
    local e = love_event_queue[i]
    if e then return unpack(e) end
    love_event_queue = {}
  end
end
-- JS pushes raw input here
function __push_event(name, a, b, c, d, e, f) love_event_queue[#love_event_queue + 1] = {name, a, b, c, d, e, f} end

love.handlers.mousepressed = function(...) if love.mousepressed then return love.mousepressed(...) end end
love.handlers.mousereleased = function(...) if love.mousereleased then return love.mousereleased(...) end end
love.handlers.mousemoved = function(...) if love.mousemoved then return love.mousemoved(...) end end
love.handlers.keypressed = function(...) if love.keypressed then return love.keypressed(...) end end
love.handlers.keyreleased = function(...) if love.keyreleased then return love.keyreleased(...) end end
love.handlers.touchpressed = function() end
love.handlers.touchreleased = function() end
love.handlers.touchmoved = function() end
love.handlers.resize = function(w, h) if love.resize then return love.resize(w, h) end end
love.handlers.wheelmoved = function() end
love.handlers.textinput = function() end
love.handlers.focus = function() end

----------------------------------------------------------------- mouse / touch / joystick / keyboard
love.mouse = {}
local mouse_visible = true
function love.mouse.setVisible(v) mouse_visible = v; J.setCursorVisible(v) end
function love.mouse.isVisible() return mouse_visible end
function love.mouse.getPosition() return J.mouseX(), J.mouseY() end
function love.mouse.setGrabbed() end
function love.mouse.setRelativeMode() end

love.touch = {}
function love.touch.getTouches() return J.touchList() end

love.joystick = {}
function love.joystick.getJoysticks() return {} end
function love.joystick.loadGamepadMappings() end

love.keyboard = {}
function love.keyboard.isDown() return false end
function love.keyboard.setKeyRepeat() end

----------------------------------------------------------------- window
love.window = {}
function love.window.getMode() local w, h = J.winSize(); return w, h, {fullscreen = false, vsync = 1, resizable = true, display = 1} end
function love.window.getDisplayCount() return 1 end
function love.window.getDesktopDimensions() return J.screenSize() end
function love.window.getFullscreenModes()
  local w, h = J.screenSize()
  return {{width = w, height = h}}
end
function love.window.updateMode() end
function love.window.setMode() return true end
function love.window.toPixels(v) return v end
function love.window.getTitle() return 'Balatro' end
function love.window.isOpen() return true end
function love.window.showMessageBox() return 1 end

----------------------------------------------------------------- data (saves are stored uncompressed)
love.data = {}
function love.data.compress(_, _, s) return s end
function love.data.decompress(_, _, s) return s end

----------------------------------------------------------------- filesystem
love.filesystem = {}
function love.filesystem.getInfo(path)
  if path == '' then return nil end
  path = tostring(path)
  local kind, size = J.fsInfo(path)
  if kind then return {type = kind, size = size} end
  return nil
end
function love.filesystem.read(path)
  local s = J.fsRead(tostring(path))
  if s == nil then return nil, 'Could not open file ' .. tostring(path) end
  return s, #s
end
function love.filesystem.write(path, data) J.fsWrite(tostring(path), data, false); return true end
function love.filesystem.append(path, data) J.fsWrite(tostring(path), data, true); return true end
function love.filesystem.remove(path) return J.fsRemove(tostring(path)) end
function love.filesystem.createDirectory(path) J.fsMkdir(tostring(path)); return true end
function love.filesystem.getDirectoryItems(dir) return J.fsList(tostring(dir)) end
function love.filesystem.getSourceBaseDirectory() return '' end
function love.filesystem.load(path)
  local s = J.fsRead(path)
  if not s then return nil, 'cannot open ' .. path end
  return load(s, '@' .. path)
end

-------------------------------------------------------------------------------
-- graphics
-------------------------------------------------------------------------------
local gfx = {}
love.graphics = gfx
local color = {1, 1, 1, 1}
local current_font
local default_font_size = 12

local function set_color(r, g, b, a)
  if type(r) == 'table' then r, g, b, a = r[1], r[2], r[3], r[4] end
  color[1], color[2], color[3], color[4] = r or 1, g or 1, b or 1, a or 1
  J.setColor(color[1], color[2], color[3], color[4])
end
gfx.setColor = set_color
function gfx.getColor() return color[1], color[2], color[3], color[4] end
function gfx.getWidth() local w = J.winSize(); return w end
function gfx.getHeight() local _, h = J.winSize(); return h end
function gfx.getDimensions() return J.winSize() end
function gfx.isCreated() return true end
function gfx.isActive() return true end
function gfx.present() end
function gfx.setDefaultFilter() end
function gfx.setLineStyle() end
gfx.setLineWidth = J.setLineWidth
function gfx.setBlendMode() end
function gfx.setScissor() end
function gfx.reset() end
gfx.origin = J.origin
gfx.push = J.push
gfx.pop = J.pop
gfx.translate = J.translate  -- JS defaults a missing y to 0
gfx.scale = J.scale          -- JS defaults a missing y to x
gfx.rotate = J.rotate

function gfx.clear(r, g, b, a)
  if type(r) == 'table' then r, g, b, a = r[1], r[2], r[3], r[4] end
  J.clear(r or 0, g or 0, b or 0, a or 1)
end

function gfx.rectangle(mode, x, y, w, h, rx, ry) J.rect(mode == 'fill', x, y, w, h, rx or 0) end
function gfx.circle(mode, x, y, r) J.circle(mode == 'fill', x, y, r) end
function gfx.polygon(mode, ...)
  local v = ...
  if type(v) ~= 'table' then v = {...} end
  J.polygon(mode == 'fill', v)
end
function gfx.line(...)
  local v = ...
  if type(v) ~= 'table' then v = {...} end
  J.polyline(v)
end

-- Images ---------------------------------------------------------------------
local Image = {}
Image.__index = Image
function Image:getWidth() return self.w / self.dpi end
function Image:getHeight() return self.h / self.dpi end
function Image:getDimensions() return self.w / self.dpi, self.h / self.dpi end
function Image:getPixelWidth() return self.w end
function Image:getPixelHeight() return self.h end
function Image:setFilter() end
function Image:getDPIScale() return self.dpi end
function Image:release() end
function Image:type() return 'Image' end

function gfx.newImage(path, flags)
  local dpi = (flags and flags.dpiscale) or 1
  local handle, w, h = J.loadImage(path)
  return setmetatable({handle = handle, w = w, h = h, dpi = dpi, path = path}, Image)
end

-- Quads ----------------------------------------------------------------------
local Quad = {}
Quad.__index = Quad
function Quad:getViewport() return self.x, self.y, self.w, self.h end
function Quad:setViewport(x, y, w, h, sw, sh)
  self.x, self.y, self.w, self.h = x, y, w, h
  if sw then self.sw, self.sh = sw, sh end
end
function Quad:type() return 'Quad' end
function gfx.newQuad(x, y, w, h, sw, sh)
  if type(sw) == 'table' then sw, sh = sw:getDimensions() end
  return setmetatable({x = x, y = y, w = w, h = h, sw = sw, sh = sh}, Quad)
end

-- Canvas (the game's one render target is drawn straight to the screen) ------
local Canvas = {}
Canvas.__index = Canvas
function Canvas:getPixelHeight() return self.h end
function Canvas:getPixelWidth() return self.w end
function Canvas:getWidth() return self.w end
function Canvas:getHeight() return self.h end
function Canvas:getDimensions() return self.w, self.h end
function Canvas:setFilter() end
function Canvas:type() return 'Canvas' end
function gfx.newCanvas(w, h) return setmetatable({w = w, h = h, is_canvas = true}, Canvas) end
function gfx.setCanvas() end

-- Shaders (emulated per name in JS) --------------------------------------------
local Shader = {}
Shader.__index = Shader
function Shader:send(name, ...)
  local v = ...
  if select('#', ...) > 1 then v = {...} end
  self.u[name] = v
  J.shaderSend(self.name, name, v)
end
function Shader:hasUniform() return true end
function Shader:type() return 'Shader' end
function gfx.newShader(path)
  local name = path:match('([^/]+)%.fs$') or path
  return setmetatable({name = name, u = {}}, Shader)
end
local active_shader
function gfx.setShader(sh) active_shader = sh; J.setShader(sh and sh.name or nil) end
function gfx.getShader() return active_shader end

-- Fonts & text ---------------------------------------------------------------
local Font = {}
Font.__index = Font
function Font:getWidth(s) return J.textWidth(self.id, tostring(s)) end
function Font:getHeight() return J.fontHeight(self.id) end
function Font:getAscent() return J.fontAscent(self.id) end
function Font:getDescent() return J.fontHeight(self.id) - J.fontAscent(self.id) end
function Font:getBaseline() return J.fontAscent(self.id) end
function Font:getLineHeight() return 1 end
function Font:setLineHeight() end
function Font:setFilter() end
function Font:type() return 'Font' end

function gfx.newFont(file, size)
  if type(file) == 'number' then file, size = nil, file end
  size = size or default_font_size
  local id = J.newFont(file, size)
  return setmetatable({id = id, file = file, size = size}, Font)
end
function gfx.setNewFont(file, size)
  current_font = gfx.newFont(file, size)
  return current_font
end
function gfx.setFont(f) current_font = f end
function gfx.getFont()
  current_font = current_font or gfx.newFont(nil, default_font_size)
  return current_font
end

local Text = {}
Text.__index = Text
local function flatten(t)
  if type(t) == 'string' then return {{false, t}}, t end
  local parts, plain, c = {}, {}, nil
  for i = 1, #t do
    if type(t[i]) == 'table' then c = t[i]
    else parts[#parts + 1] = {c or false, tostring(t[i])}; plain[#plain + 1] = tostring(t[i]) end
  end
  return parts, table.concat(plain)
end
function Text:set(t)
  self.parts, self.plain = flatten(t)
  self.w = self.font:getWidth(self.plain)
end
function Text:getWidth() return self.w end
function Text:getHeight() return self.font:getHeight() end
function Text:getDimensions() return self.w, self.font:getHeight() end
function Text:type() return 'Text' end
function Text:release() end
function gfx.newText(font, t)
  local o = setmetatable({font = font}, Text)
  o:set(t or '')
  return o
end

function gfx.print(t, a, b, c, d, e, f, g)
  local font = gfx.getFont()
  local parts, plain
  if type(a) == 'table' and a.type and a:type() == 'Font' then font = a; a, b, c, d, e, f, g = b, c, d, e, f, g end
  parts = flatten(t)
  local x, y, r, sx, sy = a or 0, b or 0, c or 0, d or 1, e or d or 1
  local ox = 0
  J.drawText(font.id, parts, x, y, r, sx, sy, 0, 0, color[1], color[2], color[3], color[4])
end
function gfx.printf(t, font, x, y, limit)
  if type(font) ~= 'table' then font, x, y, limit = gfx.getFont(), font, x, y end
  gfx.print(t, font, x, y)
end

-- draw ------------------------------------------------------------------------
function gfx.draw(d, q, x, y, r, sx, sy, ox, oy)
  local ty = d.type and d:type()
  if ty == 'Text' then
    -- (Text, x, y, r, sx, sy, ox, oy) -- no quad form
    x, y, r, sx, sy, ox, oy = q, x, y, r, sx, sy, ox
    J.drawText(d.font.id, d.parts, x or 0, y or 0, r or 0, sx or 1, sy or sx or 1, ox or 0, oy or 0,
      color[1], color[2], color[3], color[4])
    return
  end
  if d.is_canvas then return end
  local qx, qy, qw, qh
  if getmetatable(q) == Quad then
    qx, qy, qw, qh = q.x, q.y, q.w, q.h
  else
    x, y, r, sx, sy, ox, oy = q, x, y, r, sx, sy, ox
    qx, qy, qw, qh = 0, 0, d.w / d.dpi, d.h / d.dpi
  end
  J.drawImage(d.handle, d.dpi, qx, qy, qw, qh, x or 0, y or 0, r or 0, sx or 1, sy or sx or 1, ox or 0, oy or 0)
end

-- legacy fonts for engine code that expects a default font
gfx.setNewFont(nil, 12)

-------------------------------------------------------------------------------
-- audio
-------------------------------------------------------------------------------
love.audio = {}
local Source = {}
Source.__index = Source
function Source:play() J.srcPlay(self.id); return true end
function Source:stop() J.srcStop(self.id) end
function Source:isPlaying() return J.srcIsPlaying(self.id) end
function Source:setVolume(v) J.srcVolume(self.id, v) end
function Source:setPitch(p) J.srcPitch(self.id, p) end
function Source:setLooping(l) J.srcLoop(self.id, l) end
function Source:release() J.srcRelease(self.id) end
function Source:type() return 'Source' end
function love.audio.newSource(path, kind)
  local name = path:match('([^/]+)%.ogg$') or path
  local id = J.srcNew(name, kind == 'stream')
  return setmetatable({id = id}, Source)
end
function love.audio.play(s) return s:play() end
function love.audio.stop() J.srcStopAll() end
function love.audio.setVolume() end

-------------------------------------------------------------------------------
-- threads: cooperative coroutines driven by channel pushes
-------------------------------------------------------------------------------
love.thread = {}
local channels = {}
local Channel = {}
Channel.__index = Channel
function Channel:push(v)
  self.q[#self.q + 1] = v
  if self.consumer then self.consumer() end
  return #self.q
end
function Channel:pop()
  if #self.q == 0 then return nil end
  return table.remove(self.q, 1)
end
function Channel:peek() return self.q[1] end
function Channel:getCount() return #self.q end
function Channel:clear() self.q = {} end
function Channel:demand()
  while #self.q == 0 do
    if coroutine.isyieldable() then coroutine.yield() else return nil end
  end
  return table.remove(self.q, 1)
end
function Channel:supply(v) self:push(v) end
function love.thread.getChannel(name)
  channels[name] = channels[name] or setmetatable({q = {}}, Channel)
  return channels[name]
end

local Thread = {}
Thread.__index = Thread
function Thread:start(...)
  local src = ATB_READ_LUA(self.file)
  if not src then return end
  local env = setmetatable({}, {__index = _G})
  local chunk, err = load(src, '@' .. self.file, 't', env)
  if not chunk then error(err) end
  local args = {...}
  local co = coroutine.create(function() chunk(unpack(args)) end)
  self.co = co
  local function resume()
    if coroutine.status(co) == 'suspended' then
      local ok, e = coroutine.resume(co)
      if not ok then print('[thread ' .. self.file .. '] ' .. tostring(e)) end
    end
  end
  -- Every channel this thread polls wakes it when something is pushed.
  for _, name in ipairs(self.wake) do love.thread.getChannel(name).consumer = resume end
  resume()
end
function Thread:isRunning() return self.co and coroutine.status(self.co) ~= 'dead' end
function Thread:wait() end
local THREAD_CHANNELS = {
  ['engine/sound_manager.lua'] = {'sound_request'},
  ['engine/save_manager.lua'] = {'save_request'},
  ['engine/http_manager.lua'] = {},
}
function love.thread.newThread(file)
  return setmetatable({file = file, wake = THREAD_CHANNELS[file] or {}}, Thread)
end
