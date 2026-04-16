# world_generator.gd
# Procedurally populates the world with 6–10 large islands, placing 1–2 ports
# on each along the coast. Also handles ambient seagull spawns.
class_name WorldGenerator
extends Node2D

const ISLAND_SCENE: PackedScene = preload("res://scenes/island.tscn")
const PORT_SCENE: PackedScene = preload("res://scenes/port.tscn")
const SEAGULL_SCENE: PackedScene = preload("res://scenes/seagull.tscn")

@export var world_size: Vector2 = Vector2(8000, 8000)
@export var min_islands: int = 6
@export var max_islands: int = 10
@export var min_island_distance: float = 1400.0
@export var ship_safe_radius: float = 400.0

var islands: Array[Island] = []
var ports: Array[Port] = []
var ship_spawn_position: Vector2 = Vector2.ZERO

var _rng: RandomNumberGenerator
var _seagull_timer: float = 0.0
var _port_id_counter: int = 0


func generate(seed_val: int) -> void:
	_rng = RandomNumberGenerator.new()
	_rng.seed = seed_val
	seed(seed_val)

	islands.clear()
	ports.clear()
	_port_id_counter = 0

	var count: int = _rng.randi_range(min_islands, max_islands)
	var placements: Array[Vector2] = []
	var half: Vector2 = world_size * 0.5
	var attempts: int = 0

	while placements.size() < count and attempts < 400:
		attempts += 1
		var candidate: Vector2 = Vector2(
			_rng.randf_range(-half.x + 800, half.x - 800),
			_rng.randf_range(-half.y + 800, half.y - 800)
		)
		if candidate.distance_to(ship_spawn_position) < ship_safe_radius + 800:
			continue
		var ok: bool = true
		for other in placements:
			if other.distance_to(candidate) < min_island_distance:
				ok = false
				break
		if ok:
			placements.append(candidate)

	for i in placements.size():
		var pos: Vector2 = placements[i]
		var radius: float = _rng.randf_range(420.0, 720.0)
		var island: Island = ISLAND_SCENE.instantiate()
		island.island_name = GameManager.generate_island_name()
		island.position = pos
		add_child(island)
		island.generate(_rng.randi(), radius)
		islands.append(island)

		var num_ports: int = _rng.randi_range(1, 2)
		var coast_points: Array[Vector2] = island.pick_coast_points(num_ports)
		for cp in coast_points:
			var port: Port = PORT_SCENE.instantiate()
			port.port_id = _port_id_counter
			_port_id_counter += 1
			port.set_names(GameManager.generate_port_name(), island.island_name)
			port.position = pos + cp
			add_child(port)
			ports.append(port)


func _process(delta: float) -> void:
	_seagull_timer -= delta
	if _seagull_timer <= 0.0:
		_seagull_timer = randf_range(6.0, 14.0)
		_spawn_seagull()


func _spawn_seagull() -> void:
	var ship: Node = get_tree().get_first_node_in_group("ship")
	if ship == null:
		return
	var gull: Node2D = SEAGULL_SCENE.instantiate()
	var origin: Vector2 = ship.global_position + Vector2(
		randf_range(-900, 900), randf_range(-600, 600)
	)
	var direction: Vector2 = Vector2.RIGHT.rotated(randf_range(0.0, TAU))
	gull.global_position = origin
	gull.set_flight(direction, randf_range(140.0, 220.0), randf_range(7.0, 12.0))
	add_child(gull)


func get_port_by_id(id: int) -> Port:
	for p in ports:
		if p.port_id == id:
			return p
	return null


func get_nearest_safe_spawn() -> Vector2:
	return ship_spawn_position
