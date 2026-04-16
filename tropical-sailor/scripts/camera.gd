# camera.gd
# Smoothed follow camera attached to the ship. Supports optional scroll-wheel
# zoom and clamps to world bounds set by the world generator.
class_name ShipCamera
extends Camera2D

const MIN_ZOOM: float = 0.55
const MAX_ZOOM: float = 1.5
const ZOOM_STEP: float = 0.1

@export var world_size: Vector2 = Vector2(8000, 8000)


func _ready() -> void:
	position_smoothing_enabled = true
	position_smoothing_speed = 5.0
	make_current()
	_apply_limits()


func _apply_limits() -> void:
	limit_left = int(-world_size.x * 0.5)
	limit_top = int(-world_size.y * 0.5)
	limit_right = int(world_size.x * 0.5)
	limit_bottom = int(world_size.y * 0.5)


func set_world_size(size: Vector2) -> void:
	world_size = size
	_apply_limits()


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_WHEEL_UP:
			zoom = (zoom * (1.0 + ZOOM_STEP)).clamp(
				Vector2(MIN_ZOOM, MIN_ZOOM), Vector2(MAX_ZOOM, MAX_ZOOM)
			)
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			zoom = (zoom * (1.0 - ZOOM_STEP)).clamp(
				Vector2(MIN_ZOOM, MIN_ZOOM), Vector2(MAX_ZOOM, MAX_ZOOM)
			)
