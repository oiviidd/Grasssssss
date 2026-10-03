/**
 * ── CABIN ──────────────────────────────────────────────────────────────────────
 * The red cabin from Reference/kazmos.jpg: a corner of a building filling the
 * right of frame, with a dark door the visitor clicks to leave the home page.
 *
 * Same construction as the mountain — one albedo map, one env lookup for light —
 * but it is *near* rather than far, so it gets the scene's real SDF fog instead of
 * a flat haze. Without that it would sit in front of the meadow yet not share its
 * atmosphere, and read as a sticker.
 *
 * `u_faceTint` darkens whichever face turns away from the light. The reference's
 * two visible walls are the same paint at noticeably different values, and with a
 * single sky lookup for the whole box the corner disappears — the one silhouette
 * that tells you it is a building and not a flat.
 */
export const cabinVert = /* glsl */`
// 1 on the small objects laid over the building — the emblem on the door — 0 on the
// building itself. Absent on the generated cabin, where it reads 0.
attribute float detail;

varying vec3 v_worldPosition;
varying vec3 v_worldNormal;
varying vec2 v_uv;
varying vec3 v_local;
varying vec3 v_localNormal;
varying float v_detail;

void main () {
	vec4 worldPosition = modelMatrix * vec4(position, 1.0);

	v_worldPosition = worldPosition.xyz;
	v_worldNormal = normalize(mat3(modelMatrix) * normal);
	v_uv = uv;
	v_local = position;
	v_localNormal = normal;
	v_detail = detail;

	gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const cabinFrag = /* glsl */`
uniform sampler2D u_map;
uniform float u_exposure;
uniform float u_lightWrap;
uniform float u_lightTint;

// 1 for a texture with its lighting already painted in: drawn flat, because lighting it
// again from the sky would shade every shadow twice.
uniform float u_unlit;
uniform float u_faceTint;
uniform float u_alphaTest;

// Negative mip bias. At the shot's distance the 4K bake is minified roughly 4:1, and plain
// trilinear filtering then blends toward the next, blurrier level; nudging the pick half a
// level sharper brings the carving and the grain back without visible shimmer.
uniform float u_lodBias;

// The emblem on the door is a real relief, but barely a centimetre proud and baked in the
// door's own paint, so drawn unlit it melts into the wood. Two touches lift it without
// changing its colour: its edges catch or lose a light from the upper left (u_detailRelief),
// and it drops a small soft shadow down and to the right onto the door (u_detailShadow).
// u_detailMask is its silhouette, blurred, baked once at import over u_detailRect (model xy:
// min, size); u_detailDepth.x is the z of the surface it sits on. Both strengths default to
// 0, which leaves every other piece of the cabin untouched.
uniform float u_detailRelief;
uniform float u_detailShadow;
uniform sampler2D u_detailMask;
uniform vec4 u_detailRect;
uniform vec2 u_detailDepth;
uniform vec2 u_detailOffset;

varying vec3 v_worldPosition;
varying vec3 v_worldNormal;
varying vec2 v_uv;
varying vec3 v_local;
varying vec3 v_localNormal;
varying float v_detail;

#include <lusionFog>

float detailMask(vec2 offset) {
	vec2 uv = (v_local.xy - offset - u_detailRect.xy) / u_detailRect.zw;
	if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
	return texture2D(u_detailMask, uv).r;
}

float detailShade() {
	vec3 n = normalize(v_localNormal);

	if (v_detail > 0.5) {
		// Side walls by which way they face; the face itself only a touch brighter.
		float side = 1.0 - abs(n.z);
		vec2 light = normalize(vec2(- 0.55, 0.85));
		return 1.0 + u_detailRelief * (side * dot(n.xy, light) * 0.55 + (1.0 - side) * 0.05);
	}

	if (u_detailShadow <= 0.0 || n.z < 0.5) return 1.0;

	// Only on the plane it sits on, not on anything further out in the same rectangle.
	float onPlane = 1.0 - smoothstep(0.006, 0.02, abs(v_local.z - u_detailDepth.x));
	float shadow = max(detailMask(u_detailOffset), detailMask(vec2(0.0)) * 0.45);
	return 1.0 - u_detailShadow * shadow * onPlane;
}

void main () {
	vec4 texel = texture2D(u_map, v_uv, u_lodBias);
	if (texel.a < u_alphaTest) discard;

	vec3 n = normalize(mix(v_worldNormal, vec3(0.0, 1.0, 0.0), u_lightWrap));
	vec3 light = sampleSky(n);

	float lum = dot(light, vec3(0.2126, 0.7152, 0.0722));
	light = mix(vec3(lum), light, u_lightTint);
	light = mix(light, vec3(1.0), u_unlit);

	// Side walls read darker than the wall facing the camera. Derived from the geometry's
	// own normal rather than a per-mesh constant, so the same material serves every face.
	float facing = abs(dot(normalize(v_worldNormal), vec3(0.0, 0.0, 1.0)));
	float shade = mix(1.0 - u_faceTint, 1.0, facing);
	shade = mix(shade, 1.0, u_unlit);

	vec3 color = texel.rgb * light * u_exposure * shade * detailShade();

	gl_FragColor = vec4(applyFog(color, v_worldPosition), 1.0);
}
`;

/**
 * ── LANTERN GLOW ───────────────────────────────────────────────────────────────
 * The halo round the door lantern at night: a camera-facing quad, added on top. The
 * light it throws on the wall and the meadow is applyLight's job (glsl/fog.js); this is
 * only the glow in the air around the glass, which is also what sets the bloom off.
 *
 * Pulled toward the camera by u_pull so the wall the lantern hangs on does not cut the
 * halo in half. It still depth-tests, so from behind the cabin it stays hidden.
 */
export const lampGlowVert = /* glsl */`
uniform float u_size;
uniform float u_pull;
varying vec2 v_offset;

void main () {
	vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
	mvPosition.xyz += normalize(- mvPosition.xyz) * u_pull;
	mvPosition.xy += position.xy * u_size;

	v_offset = position.xy * 2.0;
	gl_Position = projectionMatrix * mvPosition;
}
`;

export const lampGlowFrag = /* glsl */`
uniform vec3 u_color;
uniform float u_glow;
varying vec2 v_offset;

void main () {
	float r2 = dot(v_offset, v_offset);
	float glow = exp(- r2 * 60.0) * 0.9 + exp(- r2 * 9.0) * 0.32 + exp(- r2 * 3.0) * 0.08;
	gl_FragColor = vec4(u_color * glow * u_glow, 1.0);
}
`;
