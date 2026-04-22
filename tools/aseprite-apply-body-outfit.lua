-- aseprite-apply-body-outfit.lua
-- Reconstructs per-facing "body only" .aseprite files from a repainted
-- template, by looking up each master frame's shapeId in the map data and
-- placing that shape's body-layer pixels back at the original canvas
-- position (plus the body cel's offset within the 32x32 template frame).
--
-- The master .aseprite must be the active sprite (pass it as the -b
-- positional arg before --script). Outputs one intermediate `<facing>-body.aseprite`
-- per facing into `out=<dir>`, each sized to the master's canvas with the
-- master's tags and frame durations preserved. PNG sheet export + cropping
-- is handled by the Node wrapper afterwards.
--
-- Params:
--   out=<dir>             Output directory for intermediate .aseprite files.
--   outfit=<path>         Painted template .aseprite (required).
--   mapLua=<path>         Lua data file that `return`s the map table
--                         (Node wrapper generates this from the JSON map).
--   facings=<csv>         Default "up,down,side".
--   bodySuffix=<name>     Part name in the outfit layers. Default "body"
--                         (so it looks for `<facing>-body` layers).

local params = app.params or {}
local outDir = params.out or error("missing --script-param out=<dir>")
local outfitPath = params.outfit or error("missing --script-param outfit=<path>")
local mapLuaPath = params.mapLua or error("missing --script-param mapLua=<path>")
local facingsArg = params.facings or "up,down,side"
local bodySuffix = params.bodySuffix or "body"

local master = app.activeSprite
if not master then error("no active sprite (pass master .aseprite)") end
if master.colorMode ~= ColorMode.RGB then
  error("master sprite must be RGB")
end

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

local function findLayer(sprite, name)
  local function walk(layers)
    for _, l in ipairs(layers) do
      if l.name == name and not l.isGroup then return l end
      if l.isGroup then
        local hit = walk(l.layers)
        if hit then return hit end
      end
    end
    return nil
  end
  return walk(sprite.layers)
end

app.fs.makeAllDirectories(outDir)

local wrote = {}

for _, facing in ipairs(facings) do
  local layerName = facing .. "-" .. bodySuffix
  local outfitLayer = findLayer(outfit, layerName)
  if not outfitLayer then
    io.stderr:write("WARN outfit layer missing: " .. layerName .. " (skipping facing)\n")
  else
    local newSprite = Sprite(master.width, master.height, ColorMode.RGB)
    newSprite.layers[1].name = "body"
    while #newSprite.frames < #master.frames do newSprite:newEmptyFrame() end
    for i = 1, #master.frames do
      newSprite.frames[i].duration = master.frames[i].duration
    end
    for _, tag in ipairs(master.tags) do
      local t = newSprite:newTag(tag.fromFrame.frameNumber, tag.toFrame.frameNumber)
      t.name = tag.name
    end
    if master.palettes[1] then
      newSprite:setPalette(Palette(master.palettes[1]))
    end

    local bodyLayer = newSprite.layers[1]
    local frameEntries = map.frames[facing] or {}
    local placed, skipped = 0, 0
    for _, entry in ipairs(frameEntries) do
      local masterFrameIdx = entry.frame + 1
      if entry.shapeId ~= nil then
        local outfitCel = outfitLayer:cel(entry.shapeId + 1)
        if outfitCel then
          newSprite:newCel(
            bodyLayer,
            masterFrameIdx,
            Image(outfitCel.image),
            Point(entry.x + outfitCel.position.x, entry.y + outfitCel.position.y)
          )
          placed = placed + 1
        else
          skipped = skipped + 1
        end
      end
    end

    local intermediatePath = app.fs.joinPath(outDir, facing .. "-" .. bodySuffix .. ".aseprite")
    newSprite:saveAs(intermediatePath)
    newSprite:close()
    wrote[#wrote + 1] = { facing = facing, path = intermediatePath, placed = placed, skipped = skipped }
  end
end

outfit:close()

for _, w in ipairs(wrote) do
  print(string.format("  %s: %d cels placed, %d skipped (missing outfit cel) -> %s",
    w.facing, w.placed, w.skipped, w.path))
end
