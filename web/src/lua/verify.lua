-- Deterministic scene driver for headless verification (?atb_verify_stage=initial|gameplay|stage2).
-- It only calls the game's own entry points (start_run, select_blind, play, cash_out) - no state is faked.
local stage = ATB_VERIFY_STAGE
if not stage or stage == '' or stage == 'initial' then return end

G.SETTINGS.skip_splash = 'Yes'
G.SETTINGS.tutorial_complete = true
G.SETTINGS.tutorial_progress = {
  forced_shop = {'j_joker', 'c_empress'}, forced_voucher = 'v_grabber', forced_tags = {'tag_handy', 'tag_garbage'},
  hold_parts = {}, completed_parts = {},
}
G.SETTINGS.GAMESPEED = 4

local phase, since = 0, 0
local function ready() return G.CONTROLLER and not G.CONTROLLER.locked and #G.E_MANAGER.queues.base < 2 end

local base_update = love.update
local base_draw = love.draw
-- Rendering is pointless while the scene is still being driven (and very slow on software GL): draw only once it is reached.
love.draw = function()
  if phase >= 99 then base_draw() end
end
local FAST_FORWARD = tonumber(ATB_VERIFY_FF) or 6      -- logic steps per rendered frame while the scene is being driven (headless virtual time is short)
local drive

love.update = function(dt)
  local n = (phase < 99) and FAST_FORWARD or 1
  if phase < 99 then dt = 0.05 end      -- fixed step while driving, independent of wall-clock speed
  for _ = 1, n do
    base_update(dt)
    since = since + dt
    drive()
  end
end

function drive()
  ATB_VERIFY_PHASE = phase
  if phase == 0 then
    if G.STATE == G.STATES.MENU and G.CONTROLLER and since > 0.3 then
      G.FUNCS.start_run(nil, {stake = 1, seed = 'ATBVERIFY'}); phase, since = 1, 0
    end
  elseif phase == 1 then
    if G.STATE == G.STATES.BLIND_SELECT and G.blind_select and G.blind_prompt_box and since > 1.5 and ready() then
      G.FUNCS.select_blind({config = {ref_table = G.P_BLINDS.bl_small}}); phase, since = 2, 0
    end
  elseif phase == 2 then
    if G.STATE == G.STATES.SELECTING_HAND and G.hand and #G.hand.cards >= G.hand.config.card_limit and ready() and since > 1 then
      if stage == 'gameplay' then
        for i = 1, 3 do G.hand:add_to_highlighted(G.hand.cards[i]) end
        phase = 98
      else
        G.GAME.blind.chips = 1; G.GAME.blind.chip_text = '1'
        G.hand:add_to_highlighted(G.hand.cards[1])
        G.FUNCS.play_cards_from_highlighted(); phase, since = 3, 0
      end
    end
  elseif phase == 3 then
    if G.STATE == G.STATES.ROUND_EVAL and G.round_eval and since > 2 then
      local btn           -- the button lives in its own UIBox, not inside G.round_eval
      for _, box in pairs(G.I.UIBOX) do btn = btn or box:get_UIE_by_ID('cash_out_button') end
      if btn then G.FUNCS.cash_out(btn); phase, since = 4, 0 end
    end
  elseif phase == 98 then
    if since > 1.5 then phase = 99 end
  elseif phase == 4 then
    if G.STATE == G.STATES.SHOP and G.shop and since > 3 then phase = 99 end
  end
end

function ATB_VERIFY_DONE() return phase >= 99 end
