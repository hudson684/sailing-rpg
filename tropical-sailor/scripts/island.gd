# island.gd
# A procedurally shaped tropical island: lush green interior, darker jungle
# patches, sandy beach ring, and a shallow water halo. StaticBody2D with a
# collision polygon matches the beach edge so ships can't sail on land.
class_name Island
extends Node2D

const INTERIOR_COLOR: Color = Color("#16A34A")
const JUNGLE_COLOR: Color = Color("#15803D")
const BEACH_COLOR: Color = Color("#FEF3C7")
const SHALLOW_COLOR: Color = Color("#67E8F9")

@export var island_radius: float = 500.0
@export var island_name: String = "Isla Verde"

var beach_polygon: PackedVector2Array = PackedVector2Array()
var interior_polygon: PackedVector2Array = PackedVector2Array()
var jungle_polygon: PackedVector2Array = PackedVector2Array()
var shallow_polygon: PackedVector2Array = PackedVector2Array()

@onready var shallow_poly: Polygon2D = $Shallow
@onready var beach_poly: Polygon2D = $Beach
@onready var interior_poly: Polygon2D = $Interior
@onready var jungle_poly: Polygon2D = $Jungle
@onready var collision: CollisionPolygon2D = $StaticBody2D/CollisionPolygon2D
@onready var label: Label = $NameLabel


func _ready() -> void:
	add_to_group("islands")


func generate(seed_val: int, radius: float, noise_scale: float = 0.35) -> void:
	island_radius = radius
	var rng: RandomNumberGenerator = RandomNumberGenerator.new()
	rng.seed = seed_val
	var noise: FastNoiseLite = FastNoiseLite.new()
	noise.seed = seed_val
	noise.frequency = 0.9
	noise.noise_type = FastNoiseLite.TYPE_SIMPLEX

	var segments: int = 48
	beach_polygon = PackedVector2Array()
	interior_polygon = PackedVector2Array()
	jungle_polygon = PackedVector2Array()
	shallow_polygon = PackedVector2Array()

	for i in segments:
		var t: float = float(i) / float(segments)
		var angle: float = t * TAU
		var nx: float = cos(angle)
		var ny: float = sin(angle)
		var n: float = noise.get_noise_2d(nx * 1.5, ny * 1.5)
		var variation: float = 1.0 + n * noise_scale
		var base_r: float = radius * variation

		var beach_r: float = base_r
		var interior_r: float = base_r * 0.82
		var jungle_r: float = base_r * (0.55 + rng.randf_range(-0.05, 0.08))
		var shallow_r: float = base_r * 1.18

		beach_polygon.append(Vector2(nx, ny) * beach_r)
		interior_polygon.append(Vector2(nx, ny) * interior_r)
		shallow_polygon.append(Vector2(nx, ny) * shallow_r)
		# Jungle polygon offset slightly for organic patches.
		var jx: float = nx + rng.randf_range(-0.05, 0.05)
		var jy: float = ny + rng.randf_range(-0.05, 0.05)
		jungle_polygon.append(Vector2(jx, jy).normalized() * jungle_r)

	if shallow_poly:
		shallow_poly.polygon = shallow_polygon
		shallow_poly.color = SHALLOW_COLOR
	if beach_poly:
		beach_poly.polygon = beach_polygon
		beach_poly.color = BEACH_COLOR
	if interior_poly:
		interior_poly.polygon = interior_polygon
		interior_poly.color = INTERIOR_COLOR
	if jungle_poly:
		jungle_poly.polygon = jungle_polygon
		jungle_poly.color = JUNGLE_COLOR
	if collision:
		collision.polygon = beach_polygon
	if label:
		label.text = island_name
		label.position = Vector2(-radius * 0.4, -radius * 0.15)


func pick_coast_points(count: int) -> Array[Vector2]:
	var result: Array[Vector2] = []
	if beach_polygon.is_empty():
		return result
	var step: int = int(float(beach_polygon.size()) / float(max(count, 1)))
	for i in count:
		var idx: int = (i * step + randi() % max(step, 1)) % beach_polygon.size()
		# Push slightly outward past the beach for dock placement.
		var pt: Vector2 = beach_polygon[idx]
		var outward: Vector2 = pt.normalized() * 60.0
		result.append(pt + outward)
	return result


func get_outline_points() -> PackedVector2Array:
	return beach_polygon
