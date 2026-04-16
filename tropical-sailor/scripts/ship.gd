# ship.gd
# Player-controlled sailing ship. Momentum-based movement with wind influence,
# collision bounce against islands, and a trailing wake line.
class_name Ship
extends CharacterBody2D

signal speed_changed(speed: float)
signal heading_changed(heading_radians: float)

const MAX_SPEED: float = 300.0
const ACCELERATION: float = 80.0
const DECELERATION: float = 40.0
const DRAG: float = 0.6
const TURN_SPEED_MIN: float = 0.6
const TURN_SPEED_MAX: float = 2.2
const BOUNCE_IMPULSE: float = 160.0
const WAKE_POINT_DISTANCE: float = 14.0
const WAKE_MAX_POINTS: int = 40
const LOW_SPEED_DOCK_THRESHOLD: float = 60.0

@export var input_enabled: bool = true

var sail_power: float = 0.0  # 0..1
var current_speed: float = 0.0
var nearby_port: Port = null

@onready var wake: Line2D = $Wake
@onready var sail: Polygon2D = $Body/Sail
@onready var flag: Polygon2D = $Body/FlagCloth
@onready var body: Node2D = $Body

var _sail_anim_time: float = 0.0
var _flag_base_points: PackedVector2Array = PackedVector2Array()


func _ready() -> void:
	add_to_group("ship")
	if flag:
		_flag_base_points = flag.polygon.duplicate()
	if wake:
		wake.top_level = true  # Wake in world space, not rotating with ship
		wake.clear_points()


func _physics_process(delta: float) -> void:
	if input_enabled and not GameManager.is_paused:
		_handle_input(delta)

	_apply_movement(delta)
	_update_wake()
	_animate_sail(delta)
	_animate_flag(delta)

	emit_signal("speed_changed", current_speed)
	emit_signal("heading_changed", rotation)


func _handle_input(delta: float) -> void:
	if Input.is_action_pressed("sail_up"):
		sail_power = clampf(sail_power + delta * 0.8, 0.0, 1.0)
	if Input.is_action_pressed("sail_down"):
		sail_power = clampf(sail_power - delta * 1.0, 0.0, 1.0)

	# Turn speed scales with speed — harder to turn when stationary.
	var speed_ratio: float = clampf(current_speed / MAX_SPEED, 0.0, 1.0)
	var turn_rate: float = lerp(TURN_SPEED_MIN, TURN_SPEED_MAX, speed_ratio)

	var turn_input: float = 0.0
	if Input.is_action_pressed("turn_left"):
		turn_input -= 1.0
	if Input.is_action_pressed("turn_right"):
		turn_input += 1.0
	rotation += turn_input * turn_rate * delta


func _apply_movement(delta: float) -> void:
	var heading: Vector2 = Vector2.RIGHT.rotated(rotation)
	var wind_mult: float = WindSystem.get_thrust_multiplier(heading)
	var thrust: float = sail_power * ACCELERATION * wind_mult

	velocity += heading * thrust * delta
	# Drag only perpendicular component and overall damping.
	velocity = velocity.move_toward(heading * velocity.length(), DRAG * 30.0 * delta)
	velocity = velocity.limit_length(MAX_SPEED)
	if sail_power <= 0.01:
		velocity = velocity.move_toward(Vector2.ZERO, DECELERATION * delta)

	var collision: KinematicCollision2D = move_and_collide(velocity * delta)
	if collision != null:
		var normal: Vector2 = collision.get_normal()
		velocity = velocity.bounce(normal) * 0.35
		velocity += normal * BOUNCE_IMPULSE * 0.5
		sail_power = clampf(sail_power - 0.25, 0.0, 1.0)

	current_speed = velocity.length()


func _update_wake() -> void:
	if wake == null:
		return
	if current_speed < 15.0:
		# Fade out trail by trimming points.
		if wake.get_point_count() > 0:
			wake.remove_point(0)
		return

	var last_pt: Vector2 = global_position
	if wake.get_point_count() > 0:
		last_pt = wake.get_point_position(wake.get_point_count() - 1)
	if global_position.distance_to(last_pt) >= WAKE_POINT_DISTANCE:
		wake.add_point(global_position)
	while wake.get_point_count() > WAKE_MAX_POINTS:
		wake.remove_point(0)


func _animate_sail(delta: float) -> void:
	_sail_anim_time += delta
	if sail == null:
		return
	var flap: float = 1.0 + 0.03 * sin(_sail_anim_time * 6.0) * (0.4 + sail_power)
	sail.scale = Vector2(flap, 1.0)


func _animate_flag(delta: float) -> void:
	if flag == null or _flag_base_points.is_empty():
		return
	var pts: PackedVector2Array = PackedVector2Array()
	for i in _flag_base_points.size():
		var p: Vector2 = _flag_base_points[i]
		var offset: float = sin(_sail_anim_time * 8.0 + p.x * 0.4) * 1.2 * (p.x / 12.0)
		pts.append(Vector2(p.x, p.y + offset))
	flag.polygon = pts


func get_sail_power() -> float:
	return sail_power


func get_heading() -> Vector2:
	return Vector2.RIGHT.rotated(rotation)


func set_nearby_port(port: Port) -> void:
	nearby_port = port


func clear_nearby_port(port: Port) -> void:
	if nearby_port == port:
		nearby_port = null


func is_ready_to_dock() -> bool:
	return nearby_port != null and current_speed < LOW_SPEED_DOCK_THRESHOLD


func undock_at(world_pos: Vector2, heading_rad: float) -> void:
	global_position = world_pos
	rotation = heading_rad
	velocity = Vector2.ZERO
	sail_power = 0.0
