/** Fullscreen-triangle/quad vertex shader shared by every post pass. */
export const quadVert = /* glsl */`
attribute vec3 position;
varying vec2 v_uv;

void main() {
    v_uv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position, 1.0 );
}
`;

/**
 * ── BLOOM: HIGH PASS ───────────────────────────────────────────────────────────
 * Soft-knee luminance threshold, plus an optional anamorphic "halo": the frame is
 * point-mirrored about the centre, pushed outward by `haloWidth`, RGB-split, and
 * added back only near the edges. That is the lens-flare-ish rim you see when the
 * camera faces the sun.
 */
export const bloomHighPassFrag = /* glsl */`
uniform sampler2D u_texture;

uniform float u_luminosityThreshold;
uniform float u_smoothWidth;

#ifdef USE_HALO
uniform vec2 u_texelSize;
uniform vec2 u_aspect;
uniform float u_haloWidth;
uniform float u_haloRGBShift;
uniform float u_haloStrength;
uniform float u_haloMaskInner;
uniform float u_haloMaskOuter;
#endif

varying vec2 v_uv;

void main() {

	vec4 texel = texture2D( u_texture, v_uv );
	vec3 luma = vec3( 0.299, 0.587, 0.114 );
	float v = dot( texel.xyz, luma );
	vec4 outputColor = vec4(0.0, 0.0, 0.0, 1.0);
	float alpha = smoothstep( u_luminosityThreshold, u_luminosityThreshold + u_smoothWidth, v );
	outputColor = mix( outputColor, texel, alpha );
	gl_FragColor = vec4(outputColor.rgb, 1.0);

	#ifdef USE_HALO
		vec2 toCenter = (v_uv - 0.5) * u_aspect;

		vec2 ghostUv = 1.0 - (toCenter + 0.5);
		vec2 ghostVec = (vec2(0.5) - ghostUv);

		vec2 direction = normalize(ghostVec);
		vec2 haloVec = direction * u_haloWidth;

		vec3 distortion = vec3(-u_texelSize.x, 0.0, u_texelSize.x) * u_haloRGBShift;
		vec2 uv = ghostUv + haloVec;

		gl_FragColor.rgb += vec3(
			texture2D(u_texture, uv + direction * distortion.r).r,
			texture2D(u_texture, uv + direction * distortion.g).g,
			texture2D(u_texture, uv + direction * distortion.b).b
		) * u_haloStrength * smoothstep(u_haloMaskInner, u_haloMaskOuter, length(toCenter));
	#endif
}
`;

/** Separable gaussian. KERNEL_RADIUS = SIGMA = 3 + 2*i for mip level i. */
export const bloomBlurFrag = /* glsl */`
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform vec2 u_direction;

float gaussianPdf(in float x, in float sigma) {
  return 0.39894 * exp( -0.5 * x * x/( sigma * sigma))/sigma;
}
void main() {
  vec2 invSize = 1.0 / u_resolution;
  float fSigma = float(SIGMA);
  float weightSum = gaussianPdf(0.0, fSigma);
  vec3 diffuseSum = texture2D( u_texture, v_uv).rgb * weightSum;
  for( int i = 1; i < KERNEL_RADIUS; i ++ ) {
    float x = float(i);
    float w = gaussianPdf(x, fSigma);
    vec2 uvOffset = u_direction * invSize * x;
    vec3 sample1 = texture2D( u_texture, v_uv + uvOffset).rgb;
    vec3 sample2 = texture2D( u_texture, v_uv - uvOffset).rgb;
    diffuseSum += (sample1 + sample2) * w;
    weightSum += 2.0 * w;
  }
  gl_FragColor = vec4(diffuseSum/weightSum, 1.0);
}
`;

/**
 * ── BLOOM: COMPOSITE ───────────────────────────────────────────────────────────
 * Note `a = 1.0 - luma`: the bloom is attenuated where the frame is *already*
 * bright. Highlights therefore bleed into the shadows rather than blowing out,
 * which is what keeps the mid-tones milky instead of clipped.
 */
export const bloomCompositeFrag = /* glsl */`
varying vec2 v_uv;
uniform sampler2D u_texture;

uniform sampler2D u_blurTexture0;
#if ITERATION > 1
uniform sampler2D u_blurTexture1;
#endif
#if ITERATION > 2
uniform sampler2D u_blurTexture2;
#endif
#if ITERATION > 3
uniform sampler2D u_blurTexture3;
#endif
#if ITERATION > 4
uniform sampler2D u_blurTexture4;
#endif
uniform float u_bloomWeights[ITERATION];

highp float rand( const in vec2 uv ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, 3.141592653589793 );
	return fract( sin( sn ) * c );
}

	// based on https://www.shadertoy.com/view/MslGR8
	vec3 dithering( vec3 color ) {
		float grid_position = rand( gl_FragCoord.xy );
		vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
		dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
		return color + dither_shift_RGB;
	}

void main() {
	vec4 c = texture2D(u_texture, v_uv);
	vec3 luma = vec3( 0.299, 0.587, 0.114 );
	float v = dot( c.xyz, luma );
	float a = 1.0 - v;

	gl_FragColor = c + (
		u_bloomWeights[0] * texture2D(u_blurTexture0, v_uv)
		#if ITERATION > 1
		+ u_bloomWeights[1] * texture2D(u_blurTexture1, v_uv)
		#endif
		#if ITERATION > 2
		+ u_bloomWeights[2] * texture2D(u_blurTexture2, v_uv)
		#endif
		#if ITERATION > 3
		+ u_bloomWeights[3] * texture2D(u_blurTexture3, v_uv)
		#endif
		#if ITERATION > 4
		+ u_bloomWeights[4] * texture2D(u_blurTexture4, v_uv)
		#endif
	) * a;

    gl_FragColor.rgb = dithering( gl_FragColor.rgb );
	gl_FragColor.a = 1.0;
}
`;

/**
 * ── FINAL GRADE ────────────────────────────────────────────────────────────────
 * This pass is doing most of the visual heavy lifting. The scene is rendered with
 * no gamma conversion at all, so the raw beauty pass is extremely dark (the grass
 * albedo map peaks around 0.2 linear). The `colorDodge`+`screen` tint is what lifts
 * it: dividing by (1 - tint) with a tint of e.g. #05c5e0 multiplies green ~4× and
 * blue ~8×, which simultaneously brightens the frame and pushes it into that
 * unmistakable teal daylight. Vignette runs before the grade, dither after.
 */
export const finalFrag = /* glsl */`
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform vec3 u_bgColor;
uniform float u_opacity;

uniform float u_vignetteFrom;
uniform float u_vignetteTo;
uniform vec2 u_vignetteAspect;
uniform vec3 u_vignetteColor;

uniform float u_saturation;
uniform float u_contrast;
uniform float u_brightness;

uniform vec3 u_tintColor;
uniform float u_tintOpacity;
uniform float u_ditherSeed;

float hash13(vec3 p3) {
	p3  = fract(p3 * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec3 screen (vec3 cb, vec3 cs) {
	return cb + cs - (cb * cs);
}

vec3 colorDodge (vec3 cb, vec3 cs) {
	return mix(
		min(vec3(1.0), cb / (1.0 - cs)),
		vec3(1.0),
		step(vec3(1.0), cs)
	);
}
void main() {

	float opacity = 1.0;
	vec2 uv = v_uv;

	vec3 color = texture2D(u_texture, uv).rgb;

	float d = length((uv - 0.5) * u_vignetteAspect) * 2.0;
	color = mix(color, u_vignetteColor, smoothstep(u_vignetteFrom, u_vignetteTo, d));

	float luma = dot(color, vec3(0.299, 0.587, 0.114));

	color = mix(vec3(luma), color, 1.0 + u_saturation);
	color = 0.5 + (1.0 + u_contrast) * (color - 0.5);
	color += u_brightness;
	color = clamp(color, vec3(0.0), vec3(1.0));

	// linear dodge add
	color = mix(color, screen(colorDodge(color, u_tintColor), u_tintColor), u_tintOpacity);

	opacity *= u_opacity;

	gl_FragColor = vec4(mix(u_bgColor, color, opacity) + hash13(vec3(gl_FragCoord.xy, u_ditherSeed)) / 255.0, 1.0);
}
`;
