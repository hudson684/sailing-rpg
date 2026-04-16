# seagull.gd
# Ambient wildlife — drawn procedurally as a small white V shape with animated
# wing flap, tweened across the view and despawned.
class_name Seagull
extends Node2D

var direction: Vector2 = Vector2.RIGHT
var speed: float = 160.0
var lifetime: float = 9.0
var _age: float = 0.0
var _flap_time: float = 0.0


func set_flight(dir: Vector2, spd: float, life: float) -> void:
	direction = dir.normalized()
	speed = spd
	lifetime = life


func _process(delta: float) -> void:
	_age += delta
	_flap_time += delta
	position += direction * speed * delta
	rotation = direction.angle()
	queue_redraw()
	if _age >= lifetime:
		queue_free()


func _draw() -> void:
	var flap: float = sin(_flap_time * 10.0) * 4.0
	var wing_span: float = 12.0
	var left_tip: Vector2 = Vector2(-wing_span, -wing_span * 0.35 - flap)
	var right_tip: Vector2 = Vector2(-wing_span, wing_span * 0.35 + flap)
	var tail: Vector2 = Vector2(-wing_span * 1.2, 0)
	var nose: Vector2 = Vector2(0, 0)
	var white: Color = Color(1, 1, 1)
	var shadow: Color = Color(1, 1, 1, 0.4)
	draw_line(nose, left_tip, white, 2.0, true)
	draw_line(nose, right_tip, white, 2.0, true)
	draw_line(tail, nose, white, 2.0, true)
	draw_line(nose + Vector2(1, 6), nose + Vector2(-10, 6), shadow, 1.2, true)
