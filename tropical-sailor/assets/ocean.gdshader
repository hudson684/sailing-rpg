// Ocean shader — bright tropical water with gentle sine waves and sun glints.
// Uses a varying to sample in local/world space so waves stay fixed to the world
// as the camera scrolls, rather than sliding across the viewport.
shader_type canvas_item;

uniform vec4 deep_color : source_color = vec4(0.078, 0.722, 0.651, 1.0);    // #14B8A6
uniform vec4 shallow_color : source_color = vec4(0.176, 0.831, 0.749, 1.0); // #2DD4BF
uniform vec4 glint_color : source_color = vec4(0.404, 0.910, 0.976, 1.0);   // #67E8F9
uniform float wave_scale : hint_range(20.0, 400.0) = 140.0;
uniform float wave_speed : hint_range(0.01, 1.0) = 0.15;
uniform float glint_density : hint_range(10.0, 400.0) = 140.0;

varying vec2 world_pos;

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void vertex() {
	world_pos = VERTEX;
}

void fragment() {
	vec2 p = world_pos;

	// Two overlapping sine waves simulate gentle surface motion.
	float w1 = sin((p.x + TIME * 40.0 * wave_speed) / wave_scale) * 0.5 + 0.5;
	float w2 = cos((p.y + TIME * 30.0 * wave_speed) / (wave_scale * 1.3)) * 0.5 + 0.5;
	float bands = smoothstep(0.35, 0.9, (w1 + w2) * 0.5);

	vec4 base = mix(deep_color, shallow_color, bands * 0.5);

	// Drifting sun glints — scattered lighter dots.
	vec2 cell = floor(p / glint_density);
	vec2 cell_uv = fract(p / glint_density);
	float glint_seed = hash(cell);
	vec2 glint_center = vec2(
		0.5 + 0.25 * sin(TIME * 0.4 + glint_seed * 6.283),
		0.5 + 0.25 * cos(TIME * 0.5 + glint_seed * 6.283)
	);
	float glint_mask = step(0.88, glint_seed);
	float d = distance(cell_uv, glint_center);
	float glint = glint_mask * smoothstep(0.12, 0.0, d);

	vec4 col = mix(base, glint_color, glint * 0.45);

	// Subtle horizontal streaks for painted-water feel.
	float streaks = sin(p.y / 12.0 + TIME * 0.2) * 0.02;
	col.rgb += streaks;

	COLOR = col;
}
