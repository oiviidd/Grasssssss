import { simplexNoiseDerivatives } from './noise.js';

/**
 * ── SKY ────────────────────────────────────────────────────────────────────────
 * A radius-15 sphere pinned to the camera, rendered from the inside. The env map
 * is sampled twice — once along the view direction and once along a mirrored
 * direction — and cross-faded by a scrolling noise channel. That is the whole
 * cloud animation: no volumetrics, just two lookups drifting against each other.
 *
 * Note the vertex shader displaces `pos` for the *sampling* direction but keeps
 * `gl_Position` on the undisplaced sphere, so the sky wobbles without the geometry
 * ever moving.
 *
 * The time of day tints those lookups and adds the sun's glow, then the moon and the
 * stars on top. Both are drawn here only: the fog sees the moon's halo but not its disc,
 * so nothing hazed toward that part of the sky picks up a moon-shaped print.
 */
export const skyVert = /* glsl */`
uniform float u_time;
varying vec3 v_worldPosition;
varying vec3 v_originalWorldPosition;

${simplexNoiseDerivatives}

void main () {
	vec3 pos = position + simplexNoiseDerivatives(vec4(position * 5.0, u_time * 0.05)).xyz * 0.04;
	v_worldPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
	v_originalWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const skyFrag = /* glsl */`
uniform sampler2D u_noiseTexture;
uniform float u_time;
uniform float u_moon;
uniform float u_stars;
varying vec3 v_worldPosition;
varying vec3 v_originalWorldPosition;

#include <lusionFog>

float starHash(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

// One candidate star per cell of a longitude/latitude grid, most cells left empty. Cells
// are about two thirds of a degree, so a star is a couple of pixels at this fov.
float stars(vec3 dir) {
	vec2 grid = vec2(atan(dir.z, dir.x), asin(clamp(dir.y, -1.0, 1.0))) * 90.0;
	vec2 cell = floor(grid);
	float h = starHash(cell);
	if (h < 0.86) return 0.0;

	vec2 centre = cell + 0.2 + 0.6 * vec2(starHash(cell + 17.3), starHash(cell + 41.9));
	float point = 1.0 - smoothstep(0.0, 0.11, length(grid - centre));
	float twinkle = 0.65 + 0.35 * sin(u_time * (1.5 + h * 4.0) + h * 80.0);
	float brightness = (h - 0.86) / 0.14;

	// Thinned toward the horizon, where real haze swallows them first.
	return point * twinkle * (0.25 + brightness * 0.75) * smoothstep(0.02, 0.25, dir.y);
}

void main () {
    vec3 worldDir = normalize(v_worldPosition - cameraPosition);
    vec2 uv = equirectUv(worldDir);

    worldDir = normalize(v_originalWorldPosition * 2.0 - v_worldPosition - cameraPosition);
    vec2 uv2 = equirectUv(worldDir);

    vec3 displacement = texture2D(u_noiseTexture, uv * vec2(30.0 , 15.0)).xyz;
    vec3 displacement2 = texture2D(u_noiseTexture, uv2 * vec2(40. , 20.0)).xyz;

    displacement.x = abs(fract(u_time * 0.1 + displacement.x) - 0.5) * 3.5;

    gl_FragColor = mix(
        texture2D(u_envTexture, uv + (displacement.yz - 0.5) * vec2(0.005, 0.0025)),
        texture2D(u_envTexture, uv2 + (displacement2.yz - 0.5) * vec2(0.005, 0.0025)),
        displacement.xxxx
    );

    // Time of day, on the undisplaced direction so the moon and stars hold still while
    // the clouds drift.
    vec3 dir = normalize(v_originalWorldPosition - cameraPosition);
    vec3 color = gl_FragColor.rgb * u_skyTint + skyGlow(dir);

    // A storybook moon, drawn about five times its real size, with the noise texture for
    // a few soft maria.
    float m = dot(dir, u_moonDir);
    float disc = smoothstep(0.99975, 0.99982, m);
    float maria = texture2D(u_noiseTexture, (dir.xy - u_moonDir.xy) * 8.0).r;
    color = mix(color, vec3(0.95, 0.96, 0.92) * (0.8 + 0.2 * maria), disc * u_moon);

    color += vec3(0.85, 0.9, 1.0) * stars(dir) * u_stars * (1.0 - disc);

    gl_FragColor.rgb = color;
}
`;
