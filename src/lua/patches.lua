-- Runtime adjustments applied after the original game scripts are loaded but before love.load runs.

-- nuGC() spins on collectgarbage('step') for a time budget; fengari has no incremental GC, so it is pure waste.
nuGC = function() end

-- Belt-and-braces for the pairs() ordering fix in love.lua: the UI layout is the one place where
-- sibling order must match the definition order exactly (pack card areas were laid out off-screen,
-- which disabled the booster-pack skip button). Walk the node list with ipairs unconditionally.
do
  local raw_spch = UIBox.set_parent_child
  UIBox.set_parent_child = function(self, node, parent)
    local UIE = UIElement(parent, self, node.n, node.config)

    --set the group of the element
    if parent and parent.config and parent.config.group then if UIE.config then UIE.config.group = parent.config.group else UIE.config = {group = parent.config.group} end end

    --set the button for the element
    if parent and parent.config and parent.config.button then if UIE.config then UIE.config.button_UIE = parent else UIE.config = {button_UIE = parent} end end
    if parent and parent.config and parent.config.button_UIE then if UIE.config then UIE.config.button_UIE = parent.config.button_UIE else UIE.config = {button = parent.config.button} end end

    if node.n and node.n == G.UIT.O and UIE.config.button then
      UIE.config.object.states.click.can = false
    end

    --current node is a container
    if (node.n and node.n == G.UIT.C or node.n == G.UIT.R or node.n == G.UIT.ROOT) and node.nodes then
      for k, v in ipairs(node.nodes) do
        self:set_parent_child(v, UIE)
      end
    end

    if not parent then
      self.UIRoot = UIE
      self.UIRoot.parent = self
    else
      table.insert(parent.children, UIE)
    end
    if node.config and node.config.mid then
      self.Mid = UIE
    end
  end
end

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
