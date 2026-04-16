# main.gd
# Root of the gameplay scene. Owns the ocean, world generator, ship, HUD,
# port menu, and camera. Wires docking interaction between port → ship → menu.
extends Node2D

const WORLD_SIZE: Vector2 = Vector2(8000, 8000)

@onready var ocean: Ocean = $Ocean
@onready var world: WorldGenerator = $World
@onready var ship: Ship = $Ship
@onready var hud: HUD = $HUD
@onready var port_menu: PortMenu = $PortMenu
@onready var camera: ShipCamera = $Ship/Camera
@onready var fade: ColorRect = $Fade/FadeRect


func _ready() -> void:
	randomize()
	ocean.set_world_size(WORLD_SIZE)
	world.world_size = WORLD_SIZE
	world.ship_spawn_position = Vector2.ZERO
	world.generate(GameManager.world_seed)
	camera.set_world_size(WORLD_SIZE)

	hud.bind_ship(ship)
	hud.bind_world(world)

	for port in world.ports:
		port.ship_entered.connect(_on_ship_entered_port)
		port.ship_exited.connect(_on_ship_exited_port)

	port_menu.closed.connect(_on_port_menu_closed)
	GameManager.ship_last_position = ship.global_position
	_fade_in()


func _fade_in() -> void:
	fade.color = Color(0, 0, 0, 1)
	var tw: Tween = create_tween()
	tw.tween_property(fade, "color:a", 0.0, 0.6)


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("dock") and not port_menu.visible:
		if ship.is_ready_to_dock():
			_open_port(ship.nearby_port)
	if event.is_action_pressed("pause"):
		if port_menu.visible:
			port_menu.close_menu()


func _on_ship_entered_port(port: Port) -> void:
	GameManager.register_port(port.port_id, port.port_name, port.island_name, port.global_position)
	hud.show_notification("Entering %s" % port.port_name, 2.0)


func _on_ship_exited_port(_port: Port) -> void:
	pass


func _open_port(port: Port) -> void:
	ship.velocity = Vector2.ZERO
	ship.sail_power = 0.0
	GameManager.current_port_id = port.port_id
	port_menu.open(port)


func _on_port_menu_closed() -> void:
	# Push ship a little outward so it doesn't immediately retrigger the dock area.
	if ship.nearby_port:
		var away: Vector2 = (ship.global_position - ship.nearby_port.global_position).normalized()
		if away == Vector2.ZERO:
			away = Vector2.RIGHT
		ship.global_position += away * 30.0
