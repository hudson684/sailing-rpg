# port.gd
# Dockable port. An Area2D trigger detects an approaching ship; when the ship
# is near and moving slowly, it emits signals that the HUD / main scene wire
# up to show a docking prompt and open the port menu.
class_name Port
extends Area2D

signal ship_entered(port: Port)
signal ship_exited(port: Port)

@export var port_name: String = "Palm Harbor"
@export var island_name: String = "Isla Verde"
@export var port_id: int = 0

var _ship_in_range: Ship = null
var _flag_time: float = 0.0
var _flag_base_points: PackedVector2Array = PackedVector2Array()

@onready var flag: Polygon2D = $Flag
@onready var label: Label = $PortLabel
@onready var collision: CollisionShape2D = $CollisionShape2D


func _ready() -> void:
	add_to_group("ports")
	body_entered.connect(_on_body_entered)
	body_exited.connect(_on_body_exited)
	monitoring = true
	if flag:
		_flag_base_points = flag.polygon.duplicate()
	if label:
		label.text = port_name


func set_names(new_port: String, new_island: String) -> void:
	port_name = new_port
	island_name = new_island
	if label:
		label.text = port_name


func _process(delta: float) -> void:
	_flag_time += delta
	_animate_flag()


func _animate_flag() -> void:
	if flag == null or _flag_base_points.is_empty():
		return
	var pts: PackedVector2Array = PackedVector2Array()
	for i in _flag_base_points.size():
		var p: Vector2 = _flag_base_points[i]
		var offset: float = sin(_flag_time * 5.0 + p.x * 0.3) * 1.6 * (p.x / 18.0)
		pts.append(Vector2(p.x, p.y + offset))
	flag.polygon = pts


func _on_body_entered(body: Node) -> void:
	var ship: Ship = body as Ship
	if ship:
		_ship_in_range = ship
		ship.set_nearby_port(self)
		ship_entered.emit(self)


func _on_body_exited(body: Node) -> void:
	var ship: Ship = body as Ship
	if ship:
		if _ship_in_range == ship:
			_ship_in_range = null
		ship.clear_nearby_port(self)
		ship_exited.emit(self)


func get_ship_in_range() -> Ship:
	return _ship_in_range


func to_data() -> Dictionary:
	return {
		"id": port_id,
		"port_name": port_name,
		"island_name": island_name,
		"position": global_position,
	}
