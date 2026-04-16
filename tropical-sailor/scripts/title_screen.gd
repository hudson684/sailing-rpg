# title_screen.gd
# Title screen with the animated ocean shader background, large yellow title,
# and a pulsing "Press any key to sail" prompt. Any input triggers a fade
# transition into the main scene.
extends Control

@onready var title_label: Label = $Center/TitleLabel
@onready var subtitle_label: Label = $Center/SubtitleLabel
@onready var prompt_label: Label = $Center/PromptLabel
@onready var fade: ColorRect = $Fade

var _transitioning: bool = false


func _ready() -> void:
	GameManager.reset_state()
	fade.color = Color(0, 0, 0, 0)
	_pulse_prompt()
	_animate_title()


func _pulse_prompt() -> void:
	var tw: Tween = create_tween().set_loops()
	tw.tween_property(prompt_label, "modulate:a", 0.25, 1.0).set_trans(Tween.TRANS_SINE)
	tw.tween_property(prompt_label, "modulate:a", 1.0, 1.0).set_trans(Tween.TRANS_SINE)


func _animate_title() -> void:
	title_label.scale = Vector2(0.9, 0.9)
	var tw: Tween = create_tween().set_loops()
	tw.tween_property(title_label, "scale", Vector2(1.03, 1.03), 2.0).set_trans(Tween.TRANS_SINE)
	tw.tween_property(title_label, "scale", Vector2(0.97, 0.97), 2.0).set_trans(Tween.TRANS_SINE)


func _unhandled_input(event: InputEvent) -> void:
	if _transitioning:
		return
	if event is InputEventKey and event.pressed:
		_start_game()
	elif event is InputEventMouseButton and event.pressed:
		_start_game()


func _start_game() -> void:
	_transitioning = true
	var tw: Tween = create_tween()
	tw.tween_property(fade, "color:a", 1.0, 0.6)
	tw.tween_callback(func() -> void:
		get_tree().change_scene_to_file("res://scenes/main.tscn")
	)
