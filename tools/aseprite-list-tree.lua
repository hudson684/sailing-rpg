-- aseprite-list-tree.lua
-- Writes the active sprite's layer tree as JSON to the path given via
-- `--script-param out=<path>`. Called by export-aseprite-parts.mjs because
-- Aseprite's CLI `--list-layers` flattens groups and loses hierarchy, so we
-- can't distinguish `side/body` from `up/body` without walking the tree.

local outPath = app.params and app.params.out
if not outPath then
  io.stderr:write("missing --script-param out=<path>\n")
  return
end

local sprite = app.activeSprite or app.sprite
if not sprite then
  io.stderr:write("no active sprite\n")
  return
end

local function escape(s)
  return s:gsub('\\', '\\\\'):gsub('"', '\\"')
end

local function encode(v)
  local t = type(v)
  if t == "boolean" then return v and "true" or "false" end
  if t == "string" then return '"' .. escape(v) .. '"' end
  if t == "table" then
    if v.__array or (#v > 0) then
      local parts = {}
      for _, x in ipairs(v) do parts[#parts + 1] = encode(x) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local parts = {}
    -- Stable-ish key order: name, path, isGroup, children.
    local order = { "name", "path", "isGroup", "children" }
    for _, k in ipairs(order) do
      if v[k] ~= nil then
        parts[#parts + 1] = '"' .. k .. '":' .. encode(v[k])
      end
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

local function walk(layer, parentPath)
  local path = parentPath == "" and layer.name or (parentPath .. "/" .. layer.name)
  local entry = {
    name = layer.name,
    path = path,
    isGroup = layer.isGroup == true,
    children = { __array = true },
  }
  if layer.isGroup then
    for _, child in ipairs(layer.layers) do
      entry.children[#entry.children + 1] = walk(child, path)
    end
  end
  return entry
end

local root = { __array = true }
for _, layer in ipairs(sprite.layers) do
  root[#root + 1] = walk(layer, "")
end

local f, err = io.open(outPath, "w")
if not f then
  io.stderr:write("cannot open " .. outPath .. ": " .. tostring(err) .. "\n")
  return
end
f:write(encode(root))
f:close()
