# ocean.gd
# Animated tropical ocean background. A large ColorRect covers the world using
# a custom shader with gentle sine waves and drifting sun glints.
class_name Ocean
extends ColorRect


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE


func set_world_size(world_size: Vector2) -> void:
	custom_minimum_size = world_size
	size = world_size
	position = -world_size * 0.5
