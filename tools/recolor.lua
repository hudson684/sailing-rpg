local fr,fg,fb=47,59,61
local tr,tg,tb=0,0,0
local spr=app.activeSprite
if not spr then return end
if spr.colorMode==ColorMode.INDEXED then
  for _,pal in ipairs(spr.palettes) do
    for i=0,#pal-1 do
      local c=pal:getColor(i)
      if c.red==fr and c.green==fg and c.blue==fb and c.alpha==255 then
        pal:setColor(i,Color{r=tr,g=tg,b=tb,a=255})
      end
    end
  end
elseif spr.colorMode==ColorMode.RGB then
  local fpx=app.pixelColor.rgba(fr,fg,fb,255)
  local tpx=app.pixelColor.rgba(tr,tg,tb,255)
  for _,cel in ipairs(spr.cels) do
    local img=cel.image:clone()
    local changed=false
    for it in img:pixels() do
      if it()==fpx then it(tpx) changed=true end
    end
    if changed then spr:newCel(cel.layer,cel.frameNumber,img,cel.position) end
  end
else
  print("skip: unsupported colorMode "..tostring(spr.colorMode))
  return
end
spr:saveAs(spr.filename)
