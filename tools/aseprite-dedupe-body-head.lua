-- aseprite-dedupe-body-head.lua
-- Like aseprite-dedupe-body-shapes.lua, but deduplicates each frame's
-- *combined* body + head cels (as a single composited image). Two frames
-- collapse iff their composited non-transparent pixels are identical after
-- tight-bbox cropping.
--
-- Writes a template .aseprite where each frame is fixed-size (default 32x32)
-- with the combined shape CENTERED, so the user has room to repaint a full
-- body+head outfit (hair, hats, long coats) beyond the original footprint.
-- Each (facing, original frame) maps to a shapeId plus the canvas (x, y)
-- where the top-left of the template frame should be blitted back — paint
-- freely anywhere inside the 32x32, reconstruction re-anchors by frame.
--
-- Params (via --script-param NAME=VALUE):
--   out=<dir>              Output directory (required).
--   facings=<csv>          Top-level group names. Default "up,down,side".
--   parts=<csv>            Leaf part names to composite inside each facing.
--                          Default "body,head".
--   frameSize=<WxH>        Template frame size. Default "32x32".
--   templateName=<name>    Default "body-head-shapes-template.aseprite".
--   jsonName=<name>        Default "body-head-shapes-map.json".
--   palette=<path>         Apply this palette to the template.

local params = app.params or {}
local outDir = params.out
if not outDir or outDir == "" then error("missing --script-param out=<dir>") end

local facingsArg = params.facings or "up,down,side"
local partsArg = params.parts or "body,head"
-- Extra empty layers per facing (e.g. "hair,helmet") that aren't populated
-- from the master file — created as blank paint surfaces so a designer can
-- author hair variants independently from helmet variants on the same
-- template. Layered ON TOP of the populated parts for each facing.
local extraPartsArg = params.extraParts or ""
local frameSizeArg = params.frameSize or "32x32"
local templateName = params.templateName or "body-head-shapes-template.aseprite"
local jsonName = params.jsonName or "body-head-shapes-map.json"
local palettePath = params.palette

local frameW, frameH = frameSizeArg:match("^(%d+)x(%d+)$")
if not frameW then error("frameSize must be WxH (got " .. frameSizeArg .. ")") end
frameW, frameH = tonumber(frameW), tonumber(frameH)

local sprite = app.activeSprite or app.sprite
if not sprite then error("no active sprite") end
if sprite.colorMode ~= ColorMode.RGB then
  error("only RGB sprites are supported")
end

local function split(s, sep)
  local out = {}
  for p in s:gmatch("([^" .. sep .. "]+)") do
    out[#out + 1] = p:match("^%s*(.-)%s*$")
  end
  return out
end

local facings = split(facingsArg, ",")
local parts = split(partsArg, ",")
local extraParts = extraPartsArg ~= "" and split(extraPartsArg, ",") or {}

-- Find a top-level group by name.
local function findGroup(name)
  for _, layer in ipairs(sprite.layers) do
    if layer.isGroup and layer.name == name then return layer end
  end
  return nil
end

-- Within a group, find a direct-child leaf layer by name.
local function findChildLeaf(group, name)
  for _, layer in ipairs(group.layers) do
    if layer.name == name and not layer.isGroup then return layer end
  end
  return nil
end

local pc = app.pixelColor

-- Composite a list of (partName, cel) pairs. Returns:
--   key          : hash of the composited tight-bbox pixels
--   w, h         : tight bbox of the combined opaque pixels
--   canvasX, Y   : canvas coord of the composite's tight-bbox top-left
--   parts        : per-part { name, pixels[], w, h, dx, dy } where (dx, dy)
--                  is the part's offset inside the composite's tight bbox.
-- Returns nil if every cel is empty or nil.
local function composite(partCels)
  local any = false
  local minCx, minCy, maxCx, maxCy = math.huge, math.huge, -math.huge, -math.huge
  for _, pc_ in ipairs(partCels) do
    local cel = pc_.cel
    if cel then
      local img = cel.image
      local cx, cy = cel.position.x, cel.position.y
      if cx < minCx then minCx = cx end
      if cy < minCy then minCy = cy end
      if cx + img.width > maxCx then maxCx = cx + img.width end
      if cy + img.height > maxCy then maxCy = cy + img.height end
      any = true
    end
  end
  if not any then return nil end
  local uw = maxCx - minCx
  local uh = maxCy - minCy
  local compImg = Image(uw, uh, ColorMode.RGB)
  compImg:clear(0)
  for _, pc_ in ipairs(partCels) do
    if pc_.cel then
      compImg:drawImage(pc_.cel.image, Point(pc_.cel.position.x - minCx, pc_.cel.position.y - minCy))
    end
  end
  local minX, minY, maxX, maxY = uw, uh, -1, -1
  for y = 0, uh - 1 do
    for x = 0, uw - 1 do
      if pc.rgbaA(compImg:getPixel(x, y)) > 0 then
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
  -- Hash the composited tight-bbox pixels.
  local keyParts = { string.format("%dx%d:", sw, sh) }
  for y = 0, sh - 1 do
    for x = 0, sw - 1 do
      keyParts[#keyParts + 1] = string.format("%08x", compImg:getPixel(minX + x, minY + y))
    end
  end
  -- Per-part tight-cropped pixel grids + their offsets within the composite
  -- bbox, so the template can place body pixels on a body layer and head
  -- pixels on a head layer while keeping their relative alignment.
  local partsOut = {}
  for _, pc_ in ipairs(partCels) do
    local cel = pc_.cel
    if cel then
      local img = cel.image
      local pw, ph = img.width, img.height
      local pMinX, pMinY, pMaxX, pMaxY = pw, ph, -1, -1
      for y = 0, ph - 1 do
        for x = 0, pw - 1 do
          if pc.rgbaA(img:getPixel(x, y)) > 0 then
            if x < pMinX then pMinX = x end
            if y < pMinY then pMinY = y end
            if x > pMaxX then pMaxX = x end
            if y > pMaxY then pMaxY = y end
          end
        end
      end
      if pMaxX >= 0 then
        local pw2 = pMaxX - pMinX + 1
        local ph2 = pMaxY - pMinY + 1
        local pPixels = {}
        for y = 0, ph2 - 1 do
          for x = 0, pw2 - 1 do
            pPixels[#pPixels + 1] = img:getPixel(pMinX + x, pMinY + y)
          end
        end
        -- Part's top-left on canvas = cel.position + (pMinX, pMinY).
        -- Its offset inside the composite tight-bbox = that minus (minCx+minX, minCy+minY).
        local partCanvasX = cel.position.x + pMinX
        local partCanvasY = cel.position.y + pMinY
        local dx = partCanvasX - (minCx + minX)
        local dy = partCanvasY - (minCy + minY)
        partsOut[#partsOut + 1] = {
          name = pc_.name,
          w = pw2, h = ph2,
          pixels = pPixels,
          dx = dx, dy = dy,
        }
      end
    end
  end
  return {
    key = table.concat(keyParts),
    w = sw, h = sh,
    canvasX = minCx + minX,
    canvasY = minCy + minY,
    parts = partsOut,
  }
end

local shapesByKey = {}
local shapes = {}
local framesByFacing = {}
local orderedFacings = {}

for _, facing in ipairs(facings) do
  local group = findGroup(facing)
  if not group then
    io.stderr:write("WARN facing group not found: " .. facing .. "\n")
  else
    local partLayers = {}
    local missing = {}
    for _, part in ipairs(parts) do
      local l = findChildLeaf(group, part)
      if l then partLayers[#partLayers + 1] = l
      else missing[#missing + 1] = part end
    end
    if #missing > 0 then
      io.stderr:write("WARN in facing '" .. facing .. "' missing parts: "
        .. table.concat(missing, ", ") .. "\n")
    end
    if #partLayers > 0 then
      orderedFacings[#orderedFacings + 1] = facing
      local bucket = {}
      framesByFacing[facing] = bucket
      for frameIdx = 1, #sprite.frames do
        local partCels = {}
        for i, layer in ipairs(partLayers) do
          partCels[#partCels + 1] = { name = parts[i], cel = layer:cel(frameIdx) }
        end
        local s = composite(partCels)
        local entry = { frame = frameIdx - 1 }
        if s then
          if s.w > frameW or s.h > frameH then
            io.stderr:write(string.format(
              "WARN shape at %s/frame %d is %dx%d, exceeds template frame %dx%d\n",
              facing, frameIdx - 1, s.w, s.h, frameW, frameH))
          end
          local id = shapesByKey[s.key]
          if id == nil then
            id = #shapes
            shapes[#shapes + 1] = { id = id, w = s.w, h = s.h, parts = s.parts,
              firstSeen = { facing = facing, frame = frameIdx - 1 } }
            shapesByKey[s.key] = id
          end
          entry.shapeId = id
          -- Where the 32x32 template frame's top-left should sit on canvas
          -- so the centered shape lands back on its original pixels.
          local offX = math.floor((frameW - s.w) / 2)
          local offY = math.floor((frameH - s.h) / 2)
          entry.x = s.canvasX - offX
          entry.y = s.canvasY - offY
        else
          entry.shapeId = nil
        end
        bucket[#bucket + 1] = entry
      end
    end
  end
end

if #shapes == 0 then error("no composited shapes found") end

local tmpl = Sprite(frameW, frameH, ColorMode.RGB)
-- One layer per (facing, part) so body and head of each facing are paintable
-- independently. Layout: facing outer, parts inner — matching the source
-- file's group structure. On any given template frame only the firstSeen
-- facing's layers have cels; other facings stay empty for that frame.
local partLayerKey = function(facing, part) return facing .. "/" .. part end
local layerByKey = {}
local firstAssigned = false
-- Layers are added bottom-up — Aseprite's newLayer() pushes onto the top
-- of the stack, so iterating parts first then extraParts inside each
-- facing gives render order (bottom→top): part1, part2, extra1, extra2.
-- For head/hair/helmet that resolves to head at the bottom, hair over
-- head, helmet over hair — the natural stacking for headgear.
for _, facing in ipairs(orderedFacings) do
  for _, part in ipairs(parts) do
    local name = facing .. "-" .. part
    local layer
    if not firstAssigned then
      layer = tmpl.layers[1]
      firstAssigned = true
    else
      layer = tmpl:newLayer()
    end
    layer.name = name
    layerByKey[partLayerKey(facing, part)] = layer
  end
  for _, extra in ipairs(extraParts) do
    local layer = tmpl:newLayer()
    layer.name = facing .. "-" .. extra
    -- Deliberately left without an entry in layerByKey — the shape-cel
    -- writer below only targets the populated parts, so extras stay empty.
  end
end
while #tmpl.frames < #shapes do tmpl:newEmptyFrame() end

for i, s in ipairs(shapes) do
  local offX = math.floor((frameW - s.w) / 2)
  local offY = math.floor((frameH - s.h) / 2)
  for _, p in ipairs(s.parts) do
    local img = Image(p.w, p.h, ColorMode.RGB)
    local idx = 1
    for y = 0, p.h - 1 do
      for x = 0, p.w - 1 do
        img:drawPixel(x, y, p.pixels[idx])
        idx = idx + 1
      end
    end
    local layer = layerByKey[partLayerKey(s.firstSeen.facing, p.name)]
    if layer then
      tmpl:newCel(layer, i, img, Point(offX + p.dx, offY + p.dy))
    end
  end
end

if Tag then
  for i = 1, #shapes do
    local tag = tmpl:newTag(i, i)
    tag.name = string.format("shape-%03d", i - 1)
  end
end

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
    id = s.id, frame = s.id, w = s.w, h = s.h, firstSeen = s.firstSeen,
  }
end
local framesOut = {}
for _, facing in ipairs(orderedFacings) do
  local arr = { __array = true }
  for _, e in ipairs(framesByFacing[facing]) do
    if e.shapeId == nil then
      arr[#arr + 1] = { frame = e.frame, shapeId = nil }
    else
      arr[#arr + 1] = { frame = e.frame, shapeId = e.shapeId, x = e.x, y = e.y }
    end
  end
  framesOut[facing] = arr
end

local manifest = {
  version = 1,
  input = app.fs.fileName(sprite.filename),
  template = {
    file = templateName,
    canvas = { w = frameW, h = frameH },
  },
  parts = (function() local a = { __array = true }; for _, p in ipairs(parts) do a[#a+1] = p end; return a end)(),
  facings = (function() local a = { __array = true }; for _, f in ipairs(orderedFacings) do a[#a+1] = f end; return a end)(),
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
  "Unique %s composites: %d (template %dx%d)",
  table.concat(parts, "+"), #shapes, frameW, frameH))
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
  print(string.format("  %-6s %3d frames, %3d unique composites, %2d empty",
    facing, #bucket, n, nulls))
end
local areas = {}
for _, s in ipairs(shapes) do areas[#areas + 1] = s.w * s.h end
table.sort(areas)
local median = areas[math.floor(#areas / 2) + 1] or 0
local outliers = {}
for _, s in ipairs(shapes) do
  if median > 0 and s.w * s.h > median * 8 then outliers[#outliers + 1] = s end
end
if #outliers > 0 then
  print(string.format("  WARN %d outlier shape(s) (>8x median area):", #outliers))
  for _, s in ipairs(outliers) do
    print(string.format("    shape %d  %dx%d  firstSeen=%s/frame %d",
      s.id, s.w, s.h, s.firstSeen.facing, s.firstSeen.frame))
  end
end
print("  template: " .. templatePath)
print("  map:      " .. jsonPath)
