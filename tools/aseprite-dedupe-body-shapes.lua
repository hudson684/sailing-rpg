-- aseprite-dedupe-body-shapes.lua
-- Deduplicate body-layer shapes across every frame of the active sprite
-- (shape = tight-bbox pixel grid, so translations collapse to one entry),
-- write a template .aseprite with one frame per unique shape, and a JSON
-- mapping (facing, frame) -> (shapeId, absolute canvas x, y).
--
-- Params (via --script-param NAME=VALUE):
--   out=<dir>              Output directory (required).
--   layers=<csv>           Group-qualified layer paths. Default:
--                          "up/body,down/body,side/body".
--   templateName=<name>    Template filename (default "body-shapes-template.aseprite").
--   jsonName=<name>        Mapping filename (default "body-shapes-map.json").
--
-- Two frames collapse to the same shape when their non-transparent pixels,
-- after cropping each to its tight bbox, are identical RGBA. Position on the
-- canvas is recorded in the JSON, not in the shape data.

local params = app.params or {}
local outDir = params.out
if not outDir or outDir == "" then error("missing --script-param out=<dir>") end

local layersArg = params.layers or "up/body,down/body,side/body"
local templateName = params.templateName or "body-shapes-template.aseprite"
local jsonName = params.jsonName or "body-shapes-map.json"
local palettePath = params.palette

local sprite = app.activeSprite or app.sprite
if not sprite then error("no active sprite") end
if sprite.colorMode ~= ColorMode.RGB then
  error("only RGB sprites are supported (got colorMode=" .. tostring(sprite.colorMode) .. ")")
end

local function split(s, sep)
  local out = {}
  for p in s:gmatch("([^" .. sep .. "]+)") do
    out[#out + 1] = p:match("^%s*(.-)%s*$")
  end
  return out
end

local layerPaths = split(layersArg, ",")

-- Walk the layer tree by group-qualified path ("up/body").
local function resolveLayer(root, parts, depth)
  depth = depth or 1
  local want = parts[depth]
  for _, layer in ipairs(root) do
    if layer.name == want then
      if depth == #parts then return layer end
      if layer.isGroup then
        local hit = resolveLayer(layer.layers, parts, depth + 1)
        if hit then return hit end
      end
    end
  end
  return nil
end

local pc = app.pixelColor

-- One pass over the cel image: find tight bbox of opaque pixels AND
-- extract those pixels into a flat RGBA array, plus a hash key.
local function shapeOf(cel)
  if cel == nil then return nil end
  local img = cel.image
  local w, h = img.width, img.height
  local minX, minY, maxX, maxY = w, h, -1, -1
  for y = 0, h - 1 do
    for x = 0, w - 1 do
      local c = img:getPixel(x, y)
      if pc.rgbaA(c) > 0 then
        if x < minX then minX = x end
        if y < minY then minY = y end
        if x > maxX then maxX = x end
        if y > maxY then maxY = y end
      end
    end
  end
  if maxX < 0 then return nil end
  local sw = maxX - minX + 1
  local sh = maxY - minY + 1
  local pixels = {}
  local keyParts = { string.format("%dx%d:", sw, sh) }
  for y = 0, sh - 1 do
    for x = 0, sw - 1 do
      local c = img:getPixel(minX + x, minY + y)
      pixels[#pixels + 1] = c
      keyParts[#keyParts + 1] = string.format("%08x", c)
    end
  end
  return {
    key = table.concat(keyParts),
    w = sw,
    h = sh,
    pixels = pixels,
    canvasX = cel.position.x + minX,
    canvasY = cel.position.y + minY,
  }
end

local shapesByKey = {}
local shapes = {}
local framesByFacing = {}
local orderedFacings = {}

for _, path in ipairs(layerPaths) do
  local parts = split(path, "/")
  local facing = parts[1]
  local layer = resolveLayer(sprite.layers, parts)
  if not layer then
    io.stderr:write("WARN layer not found: " .. path .. "\n")
  else
    if not framesByFacing[facing] then
      framesByFacing[facing] = {}
      orderedFacings[#orderedFacings + 1] = facing
    end
    local bucket = framesByFacing[facing]
    for frameIdx = 1, #sprite.frames do
      local cel = layer:cel(frameIdx)
      local s = shapeOf(cel)
      local entry = { frame = frameIdx - 1 }
      if s then
        local id = shapesByKey[s.key]
        if id == nil then
          id = #shapes
          shapes[#shapes + 1] = { id = id, w = s.w, h = s.h, pixels = s.pixels,
            firstSeen = { facing = facing, frame = frameIdx - 1 } }
          shapesByKey[s.key] = id
        end
        entry.shapeId = id
        entry.x = s.canvasX
        entry.y = s.canvasY
      else
        entry.shapeId = nil
      end
      bucket[#bucket + 1] = entry
    end
  end
end

if #shapes == 0 then error("no body-layer shapes found in any target layer") end

-- Canvas sized to the biggest shape; each shape sits at (0, 0) of its frame.
local canvasW, canvasH = 1, 1
for _, s in ipairs(shapes) do
  if s.w > canvasW then canvasW = s.w end
  if s.h > canvasH then canvasH = s.h end
end

local tmpl = Sprite(canvasW, canvasH, ColorMode.RGB)
-- One layer per facing (in the order facings appeared during scan) so each
-- frame's cel lives on the layer that owns it — the other layers stay empty.
-- Shapes that appear in more than one facing are placed on the layer of
-- their firstSeen facing; the JSON still references the shared shape id
-- from every facing that uses it.
local facingLayers = {}
local firstLayer = tmpl.layers[1]
firstLayer.name = orderedFacings[1]
facingLayers[orderedFacings[1]] = firstLayer
for i = 2, #orderedFacings do
  local layer = tmpl:newLayer()
  layer.name = orderedFacings[i]
  facingLayers[orderedFacings[i]] = layer
end

while #tmpl.frames < #shapes do tmpl:newEmptyFrame() end

for i, s in ipairs(shapes) do
  local img = Image(s.w, s.h, ColorMode.RGB)
  local idx = 1
  for y = 0, s.h - 1 do
    for x = 0, s.w - 1 do
      img:drawPixel(x, y, s.pixels[idx])
      idx = idx + 1
    end
  end
  local layer = facingLayers[s.firstSeen.facing]
  tmpl:newCel(layer, i, img, Point(0, 0))
end

-- Tag each frame with its shape id so the user can navigate in Aseprite.
-- (Skip if the Tag constructor isn't available in this Aseprite version.)
if Tag then
  for i = 1, #shapes do
    local tag = tmpl:newTag(i, i)
    tag.name = string.format("shape-%03d", i - 1)
  end
end

-- Apply a shared palette (e.g. the Hana Caraka Otterisk palette) so the
-- template's Aseprite swatches match the master file.
if palettePath and palettePath ~= "" then
  if app.fs.isFile(palettePath) then
    local palSprite = Sprite{ fromFile = palettePath }
    if palSprite and palSprite.palettes[1] then
      local pal = Palette(palSprite.palettes[1])
      palSprite:close()
      app.activeSprite = tmpl
      tmpl:setPalette(pal)
    else
      io.stderr:write("WARN could not read palette from " .. palettePath .. "\n")
    end
  else
    io.stderr:write("WARN palette file not found: " .. palettePath .. "\n")
  end
end

app.fs.makeAllDirectories(outDir)
local templatePath = app.fs.joinPath(outDir, templateName)
tmpl:saveAs(templatePath)

-- JSON encoder (manual; Aseprite Lua has no json stdlib).
local function escape(s)
  return (s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n"))
end
local function encode(v)
  local t = type(v)
  if v == nil then return "null" end
  if t == "boolean" then return v and "true" or "false" end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    if v == math.floor(v) then return string.format("%d", v) end
    return string.format("%.6g", v)
  end
  if t == "string" then return '"' .. escape(v) .. '"' end
  if t == "table" then
    if v.__array or (next(v) == nil and #v == 0) then
      local parts = {}
      for _, x in ipairs(v) do parts[#parts + 1] = encode(x) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    if #v > 0 then
      local parts = {}
      for _, x in ipairs(v) do parts[#parts + 1] = encode(x) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local parts = {}
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys)
    for _, k in ipairs(keys) do
      parts[#parts + 1] = '"' .. escape(tostring(k)) .. '":' .. encode(v[k])
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

local shapesOut = { __array = true }
for _, s in ipairs(shapes) do
  shapesOut[#shapesOut + 1] = {
    id = s.id,
    frame = s.id, -- template frame index, 0-based
    w = s.w,
    h = s.h,
    firstSeen = s.firstSeen,
  }
end

local framesOut = {}
for _, facing in ipairs(orderedFacings) do
  local arr = { __array = true }
  for _, entry in ipairs(framesByFacing[facing]) do
    if entry.shapeId == nil then
      arr[#arr + 1] = { frame = entry.frame, shapeId = nil }
    else
      arr[#arr + 1] = {
        frame = entry.frame,
        shapeId = entry.shapeId,
        x = entry.x,
        y = entry.y,
      }
    end
  end
  framesOut[facing] = arr
end

local manifest = {
  version = 1,
  input = app.fs.fileName(sprite.filename),
  template = {
    file = templateName,
    canvas = { w = canvasW, h = canvasH },
  },
  layers = (function()
    local arr = { __array = true }
    for _, p in ipairs(layerPaths) do arr[#arr + 1] = p end
    return arr
  end)(),
  shapeCount = #shapes,
  shapes = shapesOut,
  frames = framesOut,
}

local jsonPath = app.fs.joinPath(outDir, jsonName)
local f = io.open(jsonPath, "w")
if not f then error("cannot write " .. jsonPath) end
f:write(encode(manifest))
f:close()

print(string.format(
  "Unique body shapes: %d (template canvas %dx%d)", #shapes, canvasW, canvasH))
for _, facing in ipairs(orderedFacings) do
  local bucket = framesByFacing[facing]
  local uniques = {}
  local nulls = 0
  for _, e in ipairs(bucket) do
    if e.shapeId == nil then nulls = nulls + 1
    else uniques[e.shapeId] = true end
  end
  local n = 0
  for _ in pairs(uniques) do n = n + 1 end
  print(string.format("  %-6s %3d frames, %3d unique shapes, %2d empty",
    facing, #bucket, n, nulls))
end

-- Flag outliers: shapes whose footprint is very different from the median,
-- usually stray pixels left in the source file.
local areas = {}
for _, s in ipairs(shapes) do areas[#areas + 1] = s.w * s.h end
table.sort(areas)
local median = areas[math.floor(#areas / 2) + 1] or 0
local outliers = {}
for _, s in ipairs(shapes) do
  if median > 0 and s.w * s.h > median * 8 then
    outliers[#outliers + 1] = s
  end
end
if #outliers > 0 then
  print(string.format("  WARN %d outlier shape(s) (>8x median area) — probably stray pixels:", #outliers))
  for _, s in ipairs(outliers) do
    print(string.format("    shape %d  %dx%d  firstSeen=%s/frame %d",
      s.id, s.w, s.h, s.firstSeen.facing, s.firstSeen.frame))
  end
end

print("  template: " .. templatePath)
print("  map:      " .. jsonPath)
