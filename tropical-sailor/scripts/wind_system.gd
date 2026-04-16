# wind_system.gd
# Autoload singleton providing a global wind vector with drifting direction
# (noise-based) and oscillating strength. The ship asks for the current wind
# and modulates its thrust by the dot product of its heading and wind.
extends Node

signal wind_changed(direction: Vector2, strength: float)

const MIN_STRENGTH: float = 0.5
const MAX_STRENGTH: float = 1.5
const DIRECTION_CHANGE_THRESHOLD: float = 0.35  # radians (~20°)

var direction: Vector2 = Vector2.RIGHT
var strength: float = 1.0

var _noise: FastNoiseLite
var _time: float = 0.0
var _last_emitted_angle: float = 0.0


func _ready() -> void:
	_noise = FastNoiseLite.new()
	_noise.seed = randi()
	_noise.frequency = 0.05
	_noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	_last_emitted_angle = direction.angle()


func _process(delta: float) -> void:
	_time += delta
	var noise_angle: float = _noise.get_noise_1d(_time * 0.25) * PI
	direction = Vector2.RIGHT.rotated(noise_angle)
	strength = lerp(MIN_STRENGTH, MAX_STRENGTH, 0.5 + 0.5 * sin(_time * 0.3))

	var current_angle: float = direction.angle()
	if absf(wrapf(current_angle - _last_emitted_angle, -PI, PI)) >= DIRECTION_CHANGE_THRESHOLD:
		_last_emitted_angle = current_angle
		wind_changed.emit(direction, strength)


func get_thrust_multiplier(ship_heading: Vector2) -> float:
	# dot: 1 = sailing with wind, -1 = against.
	var alignment: float = ship_heading.normalized().dot(direction.normalized())
	# Map [-1, 1] -> [0.3, 1.3] so against-wind is still movable.
	var base: float = lerp(0.3, 1.3, (alignment + 1.0) * 0.5)
	return base * strength
