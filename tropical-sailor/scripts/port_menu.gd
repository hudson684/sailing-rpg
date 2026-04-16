# port_menu.gd
# Docking menu overlay shown when the player presses E at a port. Lists
# discovered ports with distances and offers a "Set Sail" button to close.
class_name PortMenu
extends CanvasLayer

signal closed()

@onready var panel: PanelContainer = $Root/Panel
@onready var title_label: Label = $Root/Panel/Margin/VBox/TitleLabel
@onready var island_label: Label = $Root/Panel/Margin/VBox/IslandLabel
@onready var discovered_list: VBoxContainer = $Root/Panel/Margin/VBox/ScrollContainer/DiscoveredList
@onready var set_sail_button: Button = $Root/Panel/Margin/VBox/ButtonRow/SetSailButton
@onready var celebration: Label = $Root/Celebration

var current_port: Port
var _celebrated_ports: Dictionary = {}


func _ready() -> void:
	layer = 10
	visible = false
	set_sail_button.pressed.connect(_on_set_sail)
	process_mode = Node.PROCESS_MODE_ALWAYS


func open(port: Port) -> void:
	current_port = port
	title_label.text = port.port_name
	island_label.text = "on %s" % port.island_name
	_populate_list(port)
	visible = true
	GameManager.set_paused(true)

	# Celebration for first-time discovery.
	if not _celebrated_ports.has(port.port_id):
		_celebrated_ports[port.port_id] = true
		_play_celebration(port.port_name)


func close_menu() -> void:
	visible = false
	GameManager.set_paused(false)
	closed.emit()


func _on_set_sail() -> void:
	close_menu()


func _unhandled_input(event: InputEvent) -> void:
	if not visible:
		return
	if event.is_action_pressed("pause") or event.is_action_pressed("dock"):
		get_viewport().set_input_as_handled()
		close_menu()


func _populate_list(port: Port) -> void:
	for c in discovered_list.get_children():
		c.queue_free()
	var here: Vector2 = port.global_position
	var ports: Array = GameManager.discovered_ports.duplicate()
	ports.sort_custom(func(a: Dictionary, b: Dictionary) -> bool:
		return a.position.distance_to(here) < b.position.distance_to(here)
	)
	for data in ports:
		var entry: HBoxContainer = HBoxContainer.new()
		var name_label: Label = Label.new()
		name_label.text = "  %s — %s" % [data.port_name, data.island_name]
		name_label.add_theme_color_override("font_color", Color("#FEF3C7"))
		name_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		entry.add_child(name_label)

		var dist_label: Label = Label.new()
		var d: float = data.position.distance_to(here)
		if data.id == port.port_id:
			dist_label.text = "HERE"
			dist_label.add_theme_color_override("font_color", Color("#FCD34D"))
		else:
			dist_label.text = "%d m" % int(d / 10.0)
			dist_label.add_theme_color_override("font_color", Color("#67E8F9"))
		entry.add_child(dist_label)
		discovered_list.add_child(entry)


func _play_celebration(port_name: String) -> void:
	celebration.text = "Discovered: %s!" % port_name
	celebration.modulate = Color(1, 1, 1, 0)
	celebration.scale = Vector2(0.7, 0.7)
	var tw: Tween = create_tween()
	tw.set_parallel(true)
	tw.tween_property(celebration, "modulate:a", 1.0, 0.5)
	tw.tween_property(celebration, "scale", Vector2(1.1, 1.1), 0.5).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.chain().tween_property(celebration, "scale", Vector2(1.0, 1.0), 0.3)
	tw.chain().tween_interval(1.5)
	tw.chain().tween_property(celebration, "modulate:a", 0.0, 0.6)
