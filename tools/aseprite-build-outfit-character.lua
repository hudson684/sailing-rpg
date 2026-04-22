-- aseprite-build-outfit-character.lua
-- Produce a full character .aseprite by starting from the master (active
-- sprite) and swapping each facing's body-layer cels with the repainted
-- outfit's body pixels (positions resolved via the body-head-shapes map).
-- The resulting file preserves master's head/hands/shadow/tags/palette, so
-- the standard tools/export-aseprite.mjs pipeline can turn it into NPC
-- sprite sheets like every other premade character.
--
-- Params:
--   out=<path>          Output .aseprite path (required).
--   outfit=<path>       Repainted template .aseprite (required).
--   mapLua=<path>       Lua map data file produced by the Node wrapper.
--   facings=<csv>       Default "up,down,side".
--   bodySuffix=<name>   Part name in the outfit layers. Default "body".

local params = app.params or {}
local outPath = params.out or error("missing --script-param out=<path>")
local outfitPath = params.outfit or error("missing --script-param outfit=<path>")
local mapLuaPath = params.mapLua or error("missing --script-param mapLua=<path>")
local facingsArg = params.facings or "up,down,side"
local bodySuffix = params.bodySuffix or "body"

local master = app.activeSprite
if not master then error("no active sprite (pass master .aseprite)") end

local facings = {}
for f in facingsArg:gmatch("([^,]+)") do
  facings[#facings + 1] = f:match("^%s*(.-)%s*$")
end

local mapChunk, chunkErr = loadfile(mapLuaPath)
if not mapChunk then error("cannot load map: " .. tostring(chunkErr)) end
local map = mapChunk()
if not map or not map.frames then error("invalid map structure") end

local outfit = Sprite{ fromFile = outfitPath }
if not outfit then error("cannot open outfit: " .. outfitPath) end

-- Find a leaf layer inside a specific group.
local function findInGroup(sprite, groupName, leafName)
  for _, l in ipairs(sprite.layers) do
    if l.isGroup and l.name == groupName then
      for _, child in ipairs(l.layers) do
        if not child.isGroup and child.name == leafName then return child end
      end
    end
  end
  return nil
end

local function findFlat(sprite, name)
  local function walk(layers)
    for _, l in ipairs(layers) do
      if not l.isGroup and l.name == name then return l end
      if l.isGroup then
        local hit = walk(l.layers)
        if hit then return hit end
      end
    end
    return nil
  end
  return walk(sprite.layers)
end

-- Work on a fresh copy so we don't touch the master file on disk.
local char = Sprite{ fromFile = master.filename }
app.activeSprite = char

for _, facing in ipairs(facings) do
  local bodyLayer = findInGroup(char, facing, bodySuffix)
  if not bodyLayer then
    io.stderr:write("WARN master layer missing: " .. facing .. "/" .. bodySuffix .. "\n")
  else
    -- Clear every cel on the body layer.
    local cels = {}
    for _, c in ipairs(bodyLayer.cels) do cels[#cels + 1] = c end
    for _, c in ipairs(cels) do char:deleteCel(c) end

    local outfitLayer = findFlat(outfit, facing .. "-" .. bodySuffix)
    if not outfitLayer then
      io.stderr:write("WARN outfit layer missing: " .. facing .. "-" .. bodySuffix .. "\n")
    else
      local entries = map.frames[facing] or {}
      local placed = 0
      for _, entry in ipairs(entries) do
        if entry.shapeId ~= nil then
          local outfitCel = outfitLayer:cel(entry.shapeId + 1)
          if outfitCel then
            char:newCel(
              bodyLayer,
              entry.frame + 1,
              Image(outfitCel.image),
              Point(entry.x + outfitCel.position.x, entry.y + outfitCel.position.y)
            )
            placed = placed + 1
          end
        end
      end
      print(string.format("  %s: %d cels swapped", facing, placed))
    end
  end
end

outfit:close()

app.fs.makeAllDirectories(app.fs.filePath(outPath))
char:saveAs(outPath)
char:close()

print("wrote: " .. outPath)
