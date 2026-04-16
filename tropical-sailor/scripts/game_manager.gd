# game_manager.gd
# Autoload singleton tracking global game state: discovered ports,
# the current dock, world seed, and pause state.
extends Node

signal port_discovered(port_data: Dictionary)
signal game_paused(is_paused: bool)

const TROPICAL_NAMES: Array[String] = [
	"Port Coral", "Palm Harbor", "Mango Bay", "Turtle Cove",
	"Sunset Key", "Hibiscus Pier", "Lagoon Landing", "Parrot Point",
	"Coconut Quay", "Azure Anchorage", "Seashell Station", "Reef Harbor",
	"Papaya Port", "Driftwood Dock", "Marlin Marina", "Pineapple Pier",
	"Tradewind Haven", "Emerald Cove", "Breezeway Bay", "Kingfisher Key",
]

const ISLAND_NAMES: Array[String] = [
	"Isla Verde", "Coral Isle", "Sunstone", "Palmetto",
	"Greenheart", "Tortuga", "Sapphire Reef", "Mirage Atoll",
	"Jadefall", "Sunward Isle", "Lotus Rock", "Driftstone",
]

var world_seed: int = 0
var discovered_ports: Array[Dictionary] = []
var current_port_id: int = -1
var ship_last_position: Vector2 = Vector2.ZERO
var is_paused: bool = false

var _used_port_names: Array[String] = []
var _used_island_names: Array[String] = []


func _ready() -> void:
	randomize()
	world_seed = randi()


func reset_state() -> void:
	discovered_ports.clear()
	_used_port_names.clear()
	_used_island_names.clear()
	current_port_id = -1
	ship_last_position = Vector2.ZERO
	is_paused = false
	randomize()
	world_seed = randi()


func generate_port_name() -> String:
	var pool: Array[String] = []
	for n in TROPICAL_NAMES:
		if not _used_port_names.has(n):
			pool.append(n)
	if pool.is_empty():
		return "Port %d" % (_used_port_names.size() + 1)
	var pick: String = pool[randi() % pool.size()]
	_used_port_names.append(pick)
	return pick


func generate_island_name() -> String:
	var pool: Array[String] = []
	for n in ISLAND_NAMES:
		if not _used_island_names.has(n):
			pool.append(n)
	if pool.is_empty():
		return "Isle %d" % (_used_island_names.size() + 1)
	var pick: String = pool[randi() % pool.size()]
	_used_island_names.append(pick)
	return pick


func register_port(port_id: int, port_name: String, island_name: String, world_position: Vector2) -> void:
	for p in discovered_ports:
		if p.id == port_id:
			return
	var data: Dictionary = {
		"id": port_id,
		"port_name": port_name,
		"island_name": island_name,
		"position": world_position,
	}
	discovered_ports.append(data)
	port_discovered.emit(data)


func set_paused(paused: bool) -> void:
	is_paused = paused
	get_tree().paused = paused
	game_paused.emit(paused)
