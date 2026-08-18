/**
 * ── GROUND ─────────────────────────────────────────────────────────────────────
 * The terrain is a 1641-vertex sculpt. Everything is driven from a single
 * projected UV — world xz mapped into 0..1 over a 10×10 unit stage — which is the
 * same UV the grass uses, so grass and ground can never disagree on colour.
 *
 * Four maps:
 *   info.rgb   (terrain_info_1) — authoring masks
 *   info.a     (terrain_info_2) — grass ↔ rock blend + how "wet/shiny" the surface is
 *   grass.jpg                   — baked grass albedo (deliberately very dark and
 *                                 saturated; the grade pass later lifts it)
 *   rocks_ground_01             — tiled 8× rock albedo, its blue channel doubles as
 *                                 a height map for derivative-based normal bumping
 *   terrain_ao                  — two baked AO channels
 */
export const terrainVert = /* glsl */`
varying vec3 v_worldPosition;
varying vec3 v_viewPosition;
varying vec3 v_viewNormal;
varying vec2 v_terrainUv;

void main () {
	vec4 worldPosition = modelMatrix * vec4(position, 1.0);
	vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
	gl_Position = projectionMatrix * mvPosition;

	v_terrainUv = worldPosition.xz / 10.0 + 0.5;

	v_worldPosition = worldPosition.xyz;
	v_viewPosition = mvPosition.xyz;
	v_viewNormal = normalMatrix * normal;
}
`;

export const terrainFrag = /* glsl */`
uniform sampler2D u_terrainInfoTexture;
uniform sampler2D u_terrainGrassTexture;
uniform sampler2D u_terrainRocksTexture;
uniform sampler2D u_terrainAOTexture;

varying vec3 v_worldPosition;
varying vec3 v_viewPosition;
varying vec3 v_viewNormal;
varying vec2 v_terrainUv;

vec2 dHdxy_fwd(float Hll, vec2 uv) {
	vec2 dSTdx = dFdx( uv );
	vec2 dSTdy = dFdy( uv );
	float dBx = texture2D( u_terrainRocksTexture, uv + dSTdx ).b - Hll;
	float dBy = texture2D( u_terrainRocksTexture, uv + dSTdy ).b - Hll;
	return vec2( dBx, dBy ) * 0.35;
}
vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
	vec3 vSigmaX = vec3( dFdx( surf_pos.x ), dFdx( surf_pos.y ), dFdx( surf_pos.z ) );
	vec3 vSigmaY = vec3( dFdy( surf_pos.x ), dFdy( surf_pos.y ), dFdy( surf_pos.z ) );
	vec3 vN = surf_norm;		// normalized
	vec3 R1 = cross( vSigmaY, vN );
	vec3 R2 = cross( vN, vSigmaX );
	float fDet = dot( vSigmaX, R1 ) * faceDirection;
	vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
	return normalize( abs( fDet ) * surf_norm - vGrad );
}

#include <lusionFog>

void main () {
	vec4 info = texture2D(u_terrainInfoTexture, v_terrainUv);

	vec3 grassColor = texture2D(u_terrainGrassTexture, v_terrainUv).rgb;

	vec2 rockUv =  v_terrainUv * 8.0;
	vec3 rockColor = texture2D(u_terrainRocksTexture, rockUv).rgb;

	// The original multiplied rockColor by a hard-coded water line at y = -0.203611 to
	// darken the submerged riverbed. There is no river here, so that term is dropped —
	// keeping it would smear a dark band across the whole outer rim of the hill.

	vec3 viewNormal = normalize(v_viewNormal);
	viewNormal = perturbNormalArb(v_viewPosition, viewNormal, dHdxy_fwd(rockColor.b, rockUv), 1.0);

	vec3 specRay = reflect(normalize(v_viewPosition), viewNormal);
	float l = smoothstep(-1.0, 1.0, dot(specRay, vec3(0.57735))) * info.a;

	vec2 aoTexel = texture2D(u_terrainAOTexture, v_terrainUv).rg;
	float ao = mix(1.0, aoTexel.r, mix(0.25, 1.0, info.a)) * aoTexel.y;

	vec3 color = mix(grassColor, rockColor, info.a);

	color = color * ao * (1.0 + l);
	gl_FragColor = vec4(applyFog(clamp(color, vec3(0.0), vec3(1.0)), v_worldPosition), 1.0);
}
`;

/** Packs terrain_info_1.rgb + terrain_info_2.r into one RGBA target, once, at boot. */
export const terrainInfoFrag = /* glsl */`
uniform sampler2D u_info1Texture;
uniform sampler2D u_info2Texture;

varying vec2 v_uv;

void main () {
	vec2 uv = v_uv;
	uv.y = 1.0 - v_uv.y;
	gl_FragColor = vec4(texture2D(u_info1Texture, uv).rgb, texture2D(u_info2Texture, uv).r);
}
`;

/**
 * ── INTERACTION FIELD ──────────────────────────────────────────────────────────
 * A 256×256 ping-pong buffer covering the same 10×10 stage. Per frame:
 *   .b   = an exponentially decaying "how recently was this trampled" mask
 *   .rg  = the direction to push, encoded 0..1, easing back to 0.5 (= no push)
 * The grass shaders read this as `drawInfo` and use .xy to shove blades sideways
 * and .z to brighten them, which is why the cursor leaves a glowing wake.
 */
export const terrainDrawFrag = /* glsl */`
uniform sampler2D u_texture;
uniform vec2 u_mouseXZ;
uniform float u_mouseRadius;
uniform float u_mouseStrength;
uniform float u_drag;

varying vec2 v_uv;

void main () {
	vec4 texel = texture2D(u_texture, v_uv);

	vec2 pos = v_uv * 10.0 - 5.0;
	vec3 delta3 = vec3(pos, 0.0) - vec3(u_mouseXZ, 0.001);
	vec2 nor = normalize(delta3).xy;
	float dist = length(delta3);
	float weight = smoothstep(u_mouseRadius, 0.0, dist) * u_mouseStrength;

	texel.b = texel.b * u_drag + weight;

	texel.rg += (0.5 - texel.rg) * (1.0 - u_drag);
	texel.rg = mix(texel.rg, nor * 0.5 + 0.5, weight);

	gl_FragColor = texel;
}
`;
