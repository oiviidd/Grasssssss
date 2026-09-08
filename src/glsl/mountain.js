/**
 * ── MOUNTAIN ───────────────────────────────────────────────────────────────────
 * The snow-capped cone from Reference/kazmos.jpg.
 *
 * Deliberately the simplest material in the project: one cylindrically-unwrapped
 * albedo map, one env lookup for light, one haze mix. All the rock, snow and gully
 * detail lives in the map, so an artist can repaint it without touching a shader —
 * which is the whole reason the geometry stays a plain cone.
 *
 * It does *not* use applyFog(). The stage SDF is a rounded box around the origin
 * with a 0.7-unit falloff, so anything at the mountain's distance sits far outside
 * it and would be mixed 100% into sky — i.e. invisible. Aerial perspective here is
 * a single flat amount instead: the mountain is uniformly far away, so a per-pixel
 * distance term would buy nothing.
 */
export const mountainVert = /* glsl */`
varying vec3 v_worldPosition;
varying vec3 v_worldNormal;
varying vec2 v_uv;

void main () {
	vec4 worldPosition = modelMatrix * vec4(position, 1.0);

	v_worldPosition = worldPosition.xyz;
	v_worldNormal = normalize(mat3(modelMatrix) * normal);
	v_uv = uv;

	gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const mountainFrag = /* glsl */`
uniform sampler2D u_map;
uniform float u_exposure;
uniform float u_haze;
uniform float u_lightWrap;
uniform float u_lightTint;

// Mist pooling around the foot of the cone. Separate from u_haze on purpose: the flat haze
// is distance, this is the band of atmosphere the base sits in, and it is what lets the rock
// be honestly dark brown while the mountain still reads as far away. Without it the choice is
// only ever "brown and close" or "grey and distant".
uniform float u_baseMist;
uniform float u_baseMistHeight;

varying vec3 v_worldPosition;
varying vec3 v_worldNormal;
varying vec2 v_uv;

#include <lusionFog>

void main () {
	vec3 albedo = texture2D(u_map, v_uv).rgb;

	// Same "lighting rig" as the rest of the scene: the sky *is* the light. Wrapping the
	// normal toward straight up before the lookup keeps the shaded side from going to the
	// horizon's dark band, which on a cone reads as a hard vertical seam.
	vec3 n = normalize(mix(v_worldNormal, vec3(0.0, 1.0, 0.0), u_lightWrap));
	vec3 light = sampleSky(n);

	// The sky is the only light, and multiplying straight through paints the whole cone in
	// its blue — snow included, which then reads as grey rock. Pulling the light toward its
	// own luminance keeps the env-lit look while letting the snow stay near-neutral.
	float lum = dot(light, vec3(0.2126, 0.7152, 0.0722));
	light = mix(vec3(lum), light, u_lightTint);

	vec3 color = albedo * light * u_exposure;

	// Aerial perspective, toward the sky actually behind the mountain. v_uv.y runs base to
	// summit, so the mist is thickest at the foot and gone by u_baseMistHeight.
	vec3 skyColor = sampleSky(normalize(v_worldPosition - cameraPosition));
	float mist = u_baseMist * (1.0 - smoothstep(0.0, max(0.001, u_baseMistHeight), v_uv.y));

	color = mix(color, skyColor, clamp(u_haze + mist, 0.0, 1.0));

	gl_FragColor = vec4(color, 1.0);
}
`;
