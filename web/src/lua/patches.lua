-- Runtime adjustments applied after the original game scripts are loaded but before love.load runs.

-- nuGC() spins on collectgarbage('step') for a time budget; fengari has no incremental GC, so it is pure waste.
nuGC = function() end

-- Platform flags: a browser has no window modes, quit button or external store links worth showing.
G.F_QUIT_BUTTON = false
G.F_VIDEO_SETTINGS = false
G.F_DISCORD = false
G.F_ENABLE_PERF_OVERLAY = false
G.F_VERBOSE = false
G.F_CRASH_REPORTS = false
G.F_HTTP_SCORES = false

-- First-run language follows the browser; a saved settings file overrides this inside G:start_up.
if ATB_DETECT_LANG then G.SETTINGS.language = ATB_DETECT_LANG() end

-- Optional scripted scene for headless verification
if ATB_VERIFY_STAGE and ATB_VERIFY_STAGE ~= '' then require('atb/verify') end
