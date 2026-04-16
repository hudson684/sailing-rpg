# hud.gd
# Heads-up display: compass, wind indicator, speed gauge, minimap, notifications
# and the docking prompt. All visuals drawn with _draw() on Control nodes.
class_name HUD
extends CanvasLayer

@onready var compass: Control = $Compass
@onready var wind_indicator: Control = $WindIndicator
@onready var speed_gauge: Control = $SpeedGauge
@onready var minimap: Control = $Minimap
@onready var notification_label: Label = $Notification
@onready var dock_prompt: Label = $DockPrompt
@onready var wind_label: Label = $WindIndicator/WindLabel

var ship: Ship
var world_generator: WorldGenerator

var ship_heading: float = 0.0
var ship_speed: float = 0.0
var wind_dir: Vector2 = Vector2.RIGHT
var wind_strength: float = 1.0

const MAX_SPEED: float = 300.0
const COMPASS_RADIUS: float = 42.0
const WIND_RADIUS: float = 44.0
const MINIMAP_RADIUS: float = 100.0
const MINIMAP_WORLD_RANGE: float = 4000.0


func _ready() -> void:
	layer = 5
	if compass:
		compass.draw.connect(_draw_compass)
	if wind_indicator:
		wind_indicator.draw.connect(_draw_wind)
	if speed_gauge:
		speed_gauge.draw.connect(_draw_speed)
	if minimap:
		minimap.draw.connect(_draw_minimap)

	notification_label.modulate.a = 0.0
	dock_prompt.modulate.a = 0.0

	WindSystem.wind_changed.connect(_on_wind_changed)
	GameManager.port_discovered.connect(_on_port_discovered)


func bind_ship(s: Ship) -> void:
	ship = s
	ship.speed_changed.connect(func(v: float) -> void: ship_speed = v)
	ship.heading_changed.connect(func(h: float) -> void: ship_heading = h)


func bind_world(w: WorldGenerator) -> void:
	world_generator = w


func _process(_delta: float) -> void:
	compass.queue_redraw()
	wind_indicator.queue_redraw()
	speed_gauge.queue_redraw()
	minimap.queue_redraw()
	_update_dock_prompt()


func _on_wind_changed(dir: Vector2, strength: float) -> void:
	wind_dir = dir
	wind_strength = strength
	if wind_label:
		wind_label.text = "Wind %d%%" % int(strength * 100.0)


func _on_port_discovered(data: Dictionary) -> void:
	show_notification("Discovered: %s" % data.port_name, 3.0)


func show_notification(text: String, duration: float = 2.5) -> void:
	notification_label.text = text
	var t: Tween = create_tween()
	t.set_trans(Tween.TRANS_SINE)
	t.tween_property(notification_label, "modulate:a", 1.0, 0.35)
	t.tween_interval(duration)
	t.tween_property(notification_label, "modulate:a", 0.0, 0.6)


func _update_dock_prompt() -> void:
	if ship == null:
		return
	var show: bool = ship.is_ready_to_dock()
	if show and ship.nearby_port != null:
		var pname: String = ship.nearby_port.port_name
		dock_prompt.text = "Press E to Dock at %s" % pname
		dock_prompt.modulate.a = lerp(dock_prompt.modulate.a, 1.0, 0.15)
	else:
		dock_prompt.modulate.a = lerp(dock_prompt.modulate.a, 0.0, 0.15)


# --- Drawing callbacks ----------------------------------------------------

func _draw_compass() -> void:
	var c: Vector2 = compass.size * 0.5
	var bg: Color = Color(0, 0, 0, 0.45)
	var rim: Color = Color("#FCD34D")
	compass.draw_circle(c, COMPASS_RADIUS + 6, bg)
	compass.draw_arc(c, COMPASS_RADIUS + 4, 0.0, TAU, 48, rim, 2.0, true)
	# Rotating cardinal ring — rotate opposite to ship heading so "N" points up.
	var labels: Dictionary = {
		"N": -PI * 0.5, "E": 0.0, "S": PI * 0.5, "W": PI,
	}
	var font: Font = compass.get_theme_default_font()
	for k in labels.keys():
		var a: float = labels[k] - ship_heading
		var pos: Vector2 = c + Vector2.RIGHT.rotated(a) * (COMPASS_RADIUS - 10)
		compass.draw_string(font, pos - Vector2(6, -6), k, HORIZONTAL_ALIGNMENT_CENTER, -1, 16, Color.WHITE)
	# Ship needle always points up (ship faces its own heading).
	compass.draw_line(c, c + Vector2(0, -COMPASS_RADIUS + 4), Color("#FCD34D"), 3.0, true)
	compass.draw_circle(c, 4, Color.WHITE)


func _draw_wind() -> void:
	var c: Vector2 = Vector2(WIND_RADIUS + 10, WIND_RADIUS + 10)
	var bg: Color = Color(0, 0, 0, 0.45)
	wind_indicator.draw_circle(c, WIND_RADIUS + 6, bg)
	wind_indicator.draw_arc(c, WIND_RADIUS + 4, 0.0, TAU, 48, Color("#67E8F9"), 2.0, true)

	var arrow: Vector2 = wind_dir.normalized() * (WIND_RADIUS - 10)
	var tail: Vector2 = c - arrow
	var tip: Vector2 = c + arrow
	wind_indicator.draw_line(tail, tip, Color("#FCD34D"), 3.0, true)
	# Arrowhead.
	var perp: Vector2 = arrow.orthogonal().normalized() * 8.0
	var back: Vector2 = tip - arrow.normalized() * 12.0
	wind_indicator.draw_colored_polygon(PackedVector2Array([tip, back + perp, back - perp]), Color("#FCD34D"))

	# Strength bar below circle.
	var bar_rect: Rect2 = Rect2(Vector2(4, WIND_RADIUS * 2 + 22), Vector2((WIND_RADIUS * 2 + 12), 8))
	wind_indicator.draw_rect(bar_rect, Color(0, 0, 0, 0.4))
	var filled: Rect2 = Rect2(bar_rect.position, Vector2(bar_rect.size.x * clampf(wind_strength / 1.5, 0.0, 1.0), bar_rect.size.y))
	wind_indicator.draw_rect(filled, Color("#67E8F9"))


func _draw_speed() -> void:
	var size: Vector2 = speed_gauge.size
	speed_gauge.draw_rect(Rect2(Vector2.ZERO, size), Color(0, 0, 0, 0.4))
	var fill_width: float = size.x * clampf(ship_speed / MAX_SPEED, 0.0, 1.0)
	speed_gauge.draw_rect(Rect2(Vector2.ZERO, Vector2(fill_width, size.y)), Color("#FCD34D"))
	speed_gauge.draw_rect(Rect2(Vector2.ZERO, size), Color("#FFFFFF"), false, 2.0)
	var font: Font = speed_gauge.get_theme_default_font()
	speed_gauge.draw_string(font, Vector2(10, size.y * 0.7), "Speed: %d" % int(ship_speed), HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color.WHITE)


func _draw_minimap() -> void:
	var c: Vector2 = minimap.size * 0.5
	var radius: float = MINIMAP_RADIUS
	minimap.draw_circle(c, radius, Color(0.08, 0.44, 0.48, 0.7))
	minimap.draw_arc(c, radius, 0.0, TAU, 64, Color("#FCD34D"), 2.0, true)
	if ship == null or world_generator == null:
		return
	var scale_factor: float = radius / MINIMAP_WORLD_RANGE
	# Draw islands.
	for island in world_generator.islands:
		var rel: Vector2 = (island.global_position - ship.global_position) * scale_factor
		if rel.length() > radius - 6:
			continue
		var r: float = max(3.0, island.island_radius * scale_factor)
		minimap.draw_circle(c + rel, r, Color("#16A34A"))
	# Ports.
	for port in world_generator.ports:
		var rel: Vector2 = (port.global_position - ship.global_position) * scale_factor
		if rel.length() > radius - 4:
			continue
		minimap.draw_circle(c + rel, 3.0, Color("#FCD34D"))
	# Ship as white triangle pointing along heading.
	var tri_forward: Vector2 = Vector2.RIGHT.rotated(ship_heading) * 8.0
	var tri_perp: Vector2 = tri_forward.orthogonal() * 0.5
	var pts: PackedVector2Array = PackedVector2Array([
		c + tri_forward,
		c - tri_forward * 0.5 + tri_perp,
		c - tri_forward * 0.5 - tri_perp,
	])
	minimap.draw_colored_polygon(pts, Color.WHITE)
