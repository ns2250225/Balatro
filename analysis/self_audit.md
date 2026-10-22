# Self-Audit (Phase 7 — grill-with-docs substitute)

`grill-with-docs` is not installed in this environment, so the audit was done by hand against the checklist the skill prescribes (architecture, async races, asset fallbacks, audio pool exhaustion, state-machine edge cases). Every finding states what was done. "Adopted" = changed in place and re-verified; "Open" = accepted limitation, documented.

## Architecture

| # | Finding | Decision |
|---|---|---|
| A-1 | Re-implementing 34k lines of Lua in JS would silently drop most of the game (the pre-existing `MIGRATE.md` promised 78/150 jokers). | **Adopted**: run the original Lua on fengari behind a LÖVE shim; zero gameplay re-implementation. |
| A-2 | The one third-party dependency (fengari) is 32-bit-integer and `delete`-heavy. | **Adopted**: patched build, reproducible from `tools/vendor/` (`sh build.sh`), differences listed in README. |
| A-3 | LÖVE threads (`sound_manager`, `save_manager`) cannot run as real threads. | **Adopted**: cooperative coroutines woken by channel pushes; original files unchanged. Sound requests are handled synchronously in the frame that pushes them (no queue growth). |
| A-4 | `love.run` is driven by `requestAnimationFrame`; a thrown Lua error would kill the loop silently. | **Adopted**: `fail()` stops the loop and shows an error overlay with the Lua traceback and a reload button; no unhandled rejection. |

| A-5 | **Found by a user report (page froze after Cash Out):** fengari's `math.randomseed` truncates the seed with `\|0`; Balatro seeds with fractions in (0,1), so every `pseudorandom()` returned the same value. Shop generation (`create_card_for_shop` resamples until it gets an available card) then never terminated, and all game randomness was degenerate. Same release also hit `table.remove` out-of-range (5.1 ignores, 5.3 raises). | **Adopted**: PRNG replaced (hash of the double's bits + mulberry32); `table.remove/insert` given 5.1 semantics; `tools/headless_boot.js 0 cashout` sweeps seeds with a watchdog (B2, C3 hung before the fix). Note: sequences differ from LuaJIT's for the same seed, so seeds are not interchangeable with the Steam build. |

## Rendering / zero-black-screen invariants

| # | Finding | Decision |
|---|---|---|
| R-1 | WebGL2 may be missing/blocked (this was hit for real: the stock verifier passes `--disable-gpu`). | **Adopted**: automatic Canvas2D fallback renderer; `webglcontextlost` shows a reload panel instead of a frozen canvas. |
| R-2 | WebGL refuses cross-origin images, which breaks `file://` double-click. | **Adopted**: all textures are shipped as data-URIs (`assets/images_data.js`). |
| R-3 | A missing image would throw in `drawImage`. | **Adopted**: `loadImage` returns a 1×1 transparent texture for unknown names and warns; no exception reaches the frame loop. |
| R-4 | Shader compile failures must not blank the scene. | **Adopted**: a failing program falls back to the default textured shader and logs once; all 19 shaders were verified to compile (`tools/shader_check.py`). |
| R-5 | The text atlas recycles pages; stale entries could draw garbage. | **Adopted**: recycled pages delete their cache keys, so the next draw re-rasterises. |
| R-6 | The CRT post-process is not implemented. | **Open (documented)**: the original draws the whole scene through a distortion shader; skipped. |
| R-7 | Canvas2D fallback only approximates shaders (shadows/dissolve/background colour); editions look plain. | **Open (documented)**: it exists to avoid a black screen, not for parity. |

## State / persistence

| # | Finding | Decision |
|---|---|---|
| S-1 | `localStorage` can throw (private mode, quota). | **Adopted**: every access is guarded; falls back to an in-memory store and tells the player once (localised toast) that progress will not survive closing the tab. |
| S-2 | Save import must not corrupt a good save. | **Adopted**: `game_id`/shape validation first; backup of the old store; restore on any exception; foreign files are rejected with the store untouched (tested). |
| S-3 | Import must refresh live state without a page reload. | **Adopted**: soft restart of the Lua VM (the store is shared across restarts); verified with a window marker that survives the import. |
| S-4 | Two tabs sharing one origin overwrite each other's saves. | **Open**: same as running the original twice; not mitigated. |
| S-5 | Binary strings: saves are UTF-8 Lua text, stored uncompressed. | **Adopted**: `love.data.compress/decompress` are identity; the original `pcall`-guarded decode path accepts that. |

## Audio

| # | Finding | Decision |
|---|---|---|
| U-1 | Decoding five 5-minute music tracks to PCM would take hundreds of MB. | **Adopted**: music streams via `HTMLAudioElement`; silent tracks start lazily at the shared clock position. |
| U-2 | Eager loading 80 files at startup exhausts sockets. | **Adopted**: lazy load + background warm-up with concurrency ≤ 3 after the first gesture. |
| U-3 | `file://` blocks `fetch`. | **Adopted**: SFX fall back to pooled `HTMLAudioElement` (cap 24 live elements; excess sounds are dropped rather than queued). |
| U-4 | Autoplay policy. | **Adopted**: one-time unlock on `pointerdown/touchstart/keydown`; music pending before the gesture starts afterwards. |
| U-5 | Audio keeps playing in a hidden tab. | **Adopted**: `visibilitychange` suspends/resumes the context and pauses streamed music. |
| U-6 | Browsers without Ogg Vorbis. | **Open**: only `.ogg` is shipped (see README); an `.m4a` mirror is a drop-in extension point (`AudioEngine.ext`). |

## Input / platform

| # | Finding | Decision |
|---|---|---|
| I-1 | Touch must produce the original `touchpressed` + `mousepressed(…, istouch)` pair. | **Adopted** and tested with a real touchscreen tap. |
| I-2 | Browser gestures (scroll/zoom/long-press menu) interfering with play. | **Adopted**: `touch-action: none`, `preventDefault` on touch, context menu suppressed. |
| I-3 | "Paste seed" reads the OS clipboard synchronously, which the web cannot do. | **Adopted (partial)**: DOM `paste` events update the clipboard cache; the in-game Paste button therefore works after a Ctrl/Cmd-V. |
| I-4 | No gamepad / on-screen keyboard (profile rename). | **Open**: not wired. |

## Performance

Measured, not guessed: the first prototype spent ~60 % of the time in fengari's `adjust_top`/`moveresults` because they `delete` stack slots (V8 dictionary-mode arrays) and `nuGC()` spun on a time budget. Both fixed. Remaining cost is dominated by the original `G:draw` traversal in the Lua VM; see README for numbers. **Open**: a faster Lua VM (WebAssembly) would help low-end devices but cannot be used on `file://` without embedding a binary.
