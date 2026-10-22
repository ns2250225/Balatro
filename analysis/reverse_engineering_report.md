# Balatro — Reverse Engineering Report

Scope: `source/gameA/` (Steam build, version string `1.0.1o-FULL`, LÖVE 11.x fused executable).
Method note: the pre-installed companion skill `reverse-engineer-anything` (REA) and Hopper were **not available** in this environment. They were not needed: the game logic ships as plain Lua source inside the executable, so Phase 1 is a source-level analysis rather than a binary disassembly.

## 1. Package dissection

| Item | Finding |
|---|---|
| `Balatro.exe` (56 MB) | PE stub of the LÖVE runtime (`love.dll`, `lua51.dll`, `SDL2.dll`, `OpenAL32.dll`, `mpg123.dll`) with the game payload appended as a **ZIP archive** (304 entries). `zipfile` opens the exe directly. |
| Engine | LÖVE 11.x on LuaJIT (`lua51.dll`), Lua 5.1 semantics, `bit` library, `jit` table. |
| Game code | ~34k lines of Lua: `main.lua`, `game.lua`, `card.lua`, `blind.lua`, `tag.lua`, `back.lua`, `cardarea.lua`, `engine/*` (Node/Moveable/Sprite/UIBox/Event/Controller/Text/Particles), `functions/*` (state_events, common_events, button_callbacks, UI_definitions, misc_functions). |
| Resources | 2x/1x PNG spritesheets (already 32-bit RGBA), 80 OGG sounds (SFX + `music1..5` + ambient), 19 GLSL pixel shaders (`resources/shaders/*.fs`), 8 TTF fonts, 15 localisations (`localization/*.lua`). |
| Platform glue | `luasteam.dll`, `steam_api64.dll` — Steam integration; skipped on the web (guarded by `love.system.getOS()`). |
| Threads | Sound, save and HTTP managers are LÖVE threads (`engine/sound_manager.lua`, `save_manager.lua`, `http_manager.lua`) talking over `love.thread` channels. |

No packing (UPX etc.) is involved; no encryption keys; no proprietary binary formats — data tables are Lua literals and saves are (deflate-compressed) Lua table strings.

## 2. Class / module graph

`Object` (`engine/object.lua`, classic OOP) → `Node` → `Moveable` → `Sprite` / `AnimatedSprite` / `UIBox` / `UIElement` / `Card` / `CardArea` / `Particles`. `Game` owns `G.I` instance registries (NODE, MOVEABLE, CARD, CARDAREA, UIBOX, ALERT, POPUP…), `G.E_MANAGER` (`EventManager`: the cooperative event queue that sequences all animation/scoring), `G.CONTROLLER` (mouse/touch/gamepad cursor logic), `G.SOUND_MANAGER`, `G.SAVE_MANAGER`. Gameplay classes: `Blind`, `Tag`, `Back` (decks), `Card` (+ `Card:calculate_joker`, ~1770 lines covering all 150 jokers), `CardArea`.

Main loop: custom `love.run` → `love.update(dt_smooth)` → `G:update`, `love.draw` → `G:draw` (painter's order over `G.I.*`).

## 3. Data formats

Prototype tables are Lua literals inside `Game:init_item_prototypes()`; they were executed (not regex-parsed) with `lupa` and dumped to JSON by `tools/extract_data.py`:

| Table | Entries |
|---|---|
| `P_CENTERS` | 299 (150 jokers, tarots, planets, spectrals, vouchers, boosters, enhancements, editions, decks) |
| `P_BLINDS` | 30 (small/big + 27 bosses/showdowns) |
| `P_TAGS` | 24 |
| `P_CARDS` | 52 |
| `P_SEALS` / `P_STAKES` | 4 / 8 |
| `init_game_object()` | hand base chips/mult/level scaling, run economy defaults |
| localisation | 15 languages (`description`/`misc` tables), 6 required languages exported to JSON |

Atlas metadata (cell sizes) comes from `Game:set_render_settings()` (cards/centres/jokers 71×95, tags/blind chips 34×34, UI 18×18 …, all at `dpiscale = 2`).

## 4. Shaders

19 LÖVE pixel shaders (`dissolve`, `foil`, `holo`, `polychrome`, `negative`, `negative_shine`, `booster`, `voucher`, `hologram`, `debuff`, `played`, `flame`, `flash`, `gold_seal`, `splash`, `background`, `CRT`) plus two vertex-only shaders (`vortex`, `skew`). They are shipped unchanged and translated at runtime to GLSL ES 3.00 (see §6). Only `CRT` is intentionally not enabled in the web build (post-process distortion).

## 5. Lua 5.1 → web runtime compatibility findings

The web port executes the **original Lua** on a Lua VM written in JavaScript (fengari, Lua 5.3 semantics). Differences that mattered, found by running the real game headlessly:

| Issue | Resolution |
|---|---|
| fengari integers are 32-bit and wrap (`2^31` chips would go negative) | `tools/vendor/patch_fengari.py`: `+ - * unm` on integers no longer wrap (JS doubles, exact to 2^53, float beyond) |
| 5.3 prints integral floats as `12.0` | patched `tostring`/concat to Lua 5.1 behaviour |
| `delete L.stack[i]` pushes V8 into dictionary mode — 60 % of runtime | replaced with `= undefined` (≈2.5× faster) |
| Missing 5.1 globals: `unpack`, `loadstring`, `math.pow/log10/atan2/cosh/sinh/tanh/ldexp`, `table.getn/maxn`, `string.gfind`, `math.mod` | `atb/love.lua` compat block |
| `bit` (LuaJIT) | pure-Lua `package.preload['bit']` |
| `collectgarbage` not implemented; `nuGC()` busy-loops on it | stubbed; `nuGC` replaced by a no-op |
| `jit` global | stub table |
| `love.thread` workers (sound / save) run `while true do channel:demand() end` | each worker runs as a coroutine in the same VM; `Channel:demand()` yields when empty and a push resumes the consumer — **original unmodified `sound_manager.lua` / `save_manager.lua` are used** |
| `love.data.compress/decompress` (deflate) | identity; saves are stored as plain Lua text in `localStorage` |

## 6. Rendering reconstruction

- `love.graphics` is implemented on WebGL2: CPU matrix stack, batched triangles, rounded-rect/polygon/line tessellation, textured quads with LÖVE quad semantics (`dpiscale`), glyph-atlas text (Canvas2D rasterised), per-shader uniform introspection so `shader:send` works for every original shader.
- LÖVE shader dialect (`extern`, `Texel`, `effect()`, `Image`, `number`, `love_ScreenSize`, `screen_coords`) is wrapped into GLSL ES 3.00; the two vertex-only shaders get a custom vertex stage using raw quad coordinates and the full transform, exactly like LÖVE.
- The game's own off-screen `CANVAS` is drawn directly to the screen (CRT post pass omitted).
- Fallback: if WebGL2 is unavailable, a Canvas2D renderer emulates shadows, dissolve and the background colours so the game never goes black.

## 7. Audio reconstruction

`love.audio.Source` is backed by Web Audio (decoded once, polyphonic, `playbackRate` pitch). The original music system plays all five `music*` tracks simultaneously and crossfades by volume; to avoid five decoded 5-minute buffers the web port streams music through `HTMLAudioElement`, starting a silent track lazily at the shared music-clock position so the tracks stay in sync. `file://` falls back to `HTMLAudioElement` for SFX. Sound IDs are the original file names (`resources/sounds/<id>.ogg`), so the original `play_sound('chips1', ...)` calls map 1:1.

## 8. Not ported / deliberately different

- Steam (achievements/stats/cloud) — disabled, `G.STEAM` is nil as on non-desktop platforms.
- Window-mode/resolution/vsync settings and the Quit button are hidden (`G.F_VIDEO_SETTINGS = false`, `G.F_QUIT_BUTTON = false`).
- Video files (`democta.ogv` demo CTA) — never shown in the full game.
- Crash-report upload/HTTP leaderboards — disabled.
- CRT post-process shader — omitted.
