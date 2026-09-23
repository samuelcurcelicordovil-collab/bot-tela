// ============================================================
// Filtros de camera (visual estilo Instagram)
//
// Extraido do prototipo "GESTO — efeitos por gesto". Um filtro e apenas um
// conjunto de parametros para UM shader WebGL: trocar de filtro nao recompila
// nada, so muda os numeros enviados ao shader. Por isso da pra alternar no
// meio da transmissao sem cortar o video de ninguem.
//
// Mora em arquivo separado porque sao ~260 linhas de shader — no index.html
// isso afogaria o resto do codigo.
// ============================================================
(function (global) {
  'use strict';

  const FILTER_DEFAULTS = {
    pixel: [0, 0],        // low-res grid in cells (0 = full resolution)
    pixelSmooth: 0,       // 1 = blurry upscale (cheap webcam), 0 = hard pixels
    blur: [0, 0],         // soft focus, in pixels at 720px wide
    chroma: 0,            // red/blue fringe offset (fraction of the width)
    vhs: 0,               // tape wobble, tearing band and tracking noise
    posterize: 0,         // color levels per channel (0 = off)
    palette: 0,           // 1 = 4-shade Game Boy palette
    brightness: 1, contrast: 1, saturation: 1,
    fade: 0,              // lifted blacks / dimmed whites
    sepia: 0, gray: 0,
    tint: [1, 1, 1],      // color multiplier
    shadowTint: [0, 0, 0], highTint: [0, 0, 0], // split toning
    vignette: 0, grain: 0, scanlines: 0,
    leak: 0,              // warm light leak drifting in from a corner
    scratches: 0, flicker: 0, jitter: 0,        // old film reel
  };
  const FILTERS = [
    { id:"normal",      name:"Normal",          p:{} },
    { id:"vintage",     name:"Vintage 70",      p:{ contrast:0.9, saturation:0.72, fade:0.55, tint:[1.08,1.0,0.82], shadowTint:[0.03,0.01,-0.03], highTint:[0.05,0.02,-0.05], vignette:0.55, grain:0.07, blur:[0.7,0.7] } },
    { id:"polaroid",    name:"Polaroid",        p:{ brightness:1.05, contrast:0.84, saturation:0.8, fade:0.75, shadowTint:[-0.02,0.04,0.07], highTint:[0.07,0.04,-0.03], vignette:0.35, grain:0.04, blur:[0.5,0.5] } },
    { id:"descartavel", name:"Descartável",     overlay:"date", p:{ contrast:1.2, saturation:1.15, fade:0.12, tint:[1.06,1.0,0.88], vignette:0.65, grain:0.12, leak:0.6, blur:[0.6,0.6], chroma:0.0008 } },
    { id:"vhs",         name:"VHS",             overlay:"vhs", p:{ blur:[2.4,0.4], chroma:0.004, vhs:1, saturation:0.78, contrast:1.05, fade:0.22, tint:[0.98,1.02,1.06], scanlines:0.22, grain:0.08, vignette:0.3 } },
    { id:"baixa",       name:"Qualidade baixa", holdMs:1000/12, p:{ pixel:[160,120], pixelSmooth:1, posterize:12, saturation:0.85, contrast:1.12, brightness:1.04, tint:[0.97,1.03,0.95], grain:0.05 } },
    { id:"noir",        name:"Noir",            p:{ gray:1, contrast:1.45, brightness:1.02, vignette:0.7, grain:0.1 } },
    { id:"cinema",      name:"Cinema mudo",     holdMs:1000/18, p:{ gray:1, sepia:0.55, contrast:1.25, fade:0.2, vignette:0.85, grain:0.14, scratches:0.8, flicker:0.14, jitter:0.004, blur:[0.6,0.6] } },
    { id:"gameboy",     name:"Game Boy",        holdMs:1000/20, p:{ pixel:[160,120], palette:1, contrast:1.25, brightness:1.05 } },
    { id:"neon",        name:"Neon",            p:{ contrast:1.18, saturation:1.45, shadowTint:[0.03,-0.03,0.12], highTint:[0.1,-0.03,0.07], vignette:0.4, chroma:0.0015 } },
    { id:"verao",       name:"Verão",           p:{ brightness:1.05, contrast:1.06, saturation:1.22, tint:[1.08,1.02,0.88], fade:0.12, vignette:0.25, leak:0.28 } },
    { id:"inverno",     name:"Inverno",         p:{ brightness:1.03, contrast:0.96, saturation:0.78, tint:[0.9,1.0,1.12], fade:0.3, shadowTint:[-0.02,0.02,0.06], vignette:0.3 } },
  ];
  const FILTER_BY_ID = Object.fromEntries(FILTERS.map(f => [f.id, f]));

  const FILTER_VS = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main(){
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }`;

  const FILTER_FS = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    uniform vec2 u_res;
    uniform vec2 u_uvScale;
    uniform vec2 u_uvOffset;
    uniform float u_mirror;
    uniform float u_time;
    uniform float u_mix;
    uniform float u_pxScale;
    uniform vec2 u_pixel;
    uniform float u_pixelSmooth;
    uniform vec2 u_blur;
    uniform float u_chroma;
    uniform float u_vhs;
    uniform float u_posterize;
    uniform float u_palette;
    uniform float u_brightness;
    uniform float u_contrast;
    uniform float u_saturation;
    uniform float u_fade;
    uniform float u_sepia;
    uniform float u_gray;
    uniform vec3 u_tint;
    uniform vec3 u_shadowTint;
    uniform vec3 u_highTint;
    uniform float u_vignette;
    uniform float u_grain;
    uniform float u_scanlines;
    uniform float u_leak;
    uniform float u_scratches;
    uniform float u_flicker;
    uniform float u_jitter;

    const vec3 LUMA = vec3(0.299, 0.587, 0.114);

    float hash(vec2 p){
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // p: screen position, 0..1 from the top-left; mirrored and cover-cropped like the video
    vec3 samp(vec2 p){
      if (u_mirror > 0.5) p.x = 1.0 - p.x;
      return texture2D(u_tex, u_uvOffset + clamp(p, 0.0, 1.0) * u_uvScale).rgb;
    }

    vec3 tap(vec2 q){
      if (u_chroma <= 0.0) return samp(q);
      vec2 o = vec2(u_chroma, 0.0);
      return vec3(samp(q + o).r, samp(q).g, samp(q - o).b);
    }

    vec3 blurred(vec2 q){
      if (u_blur.x <= 0.0 && u_blur.y <= 0.0) return tap(q);
      vec2 b = u_blur * u_pxScale / u_res;
      return (tap(q) * 2.0
        + tap(q + vec2(b.x, 0.0)) + tap(q - vec2(b.x, 0.0))
        + tap(q + vec2(0.0, b.y)) + tap(q - vec2(0.0, b.y))) / 6.0;
    }

    vec3 scene(vec2 q){
      if (u_pixel.x <= 0.0) return blurred(q);
      if (u_pixelSmooth < 0.5) return blurred((floor(q * u_pixel) + 0.5) / u_pixel);
      vec2 g = q * u_pixel - 0.5;
      vec2 b = floor(g);
      vec2 f = fract(g);
      vec3 c00 = blurred((b + vec2(0.5, 0.5)) / u_pixel);
      vec3 c10 = blurred((b + vec2(1.5, 0.5)) / u_pixel);
      vec3 c01 = blurred((b + vec2(0.5, 1.5)) / u_pixel);
      vec3 c11 = blurred((b + vec2(1.5, 1.5)) / u_pixel);
      return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
    }

    void main(){
      vec2 p = vec2(v_uv.x, 1.0 - v_uv.y);
      float t = u_time;
      float frame = floor(t * 24.0);
      vec2 q = p;

      // old projector gate weave
      if (u_jitter > 0.0){
        q += (vec2(hash(vec2(frame, 1.0)), hash(vec2(frame, 7.0))) - 0.5) * u_jitter;
      }

      // tape wobble per scanline plus a rolling tear band
      float band = 0.0;
      if (u_vhs > 0.0){
        float line = floor(p.y * 240.0);
        float bandPos = fract(t * 0.11) * 1.3 - 0.15;
        band = 1.0 - smoothstep(0.0, 0.07, abs(p.y - bandPos));
        float wobble = (hash(vec2(line, floor(t * 30.0))) - 0.5) * 0.002;
        float tear = band * (hash(vec2(line, frame)) - 0.5) * 0.035;
        q.x += (wobble + tear + sin(p.y * 10.0 + t * 1.7) * 0.0012) * u_vhs;
      }

      vec3 orig = samp(p);
      vec3 col = scene(q);

      // color grade
      col *= u_brightness;
      col = (col - 0.5) * u_contrast + 0.5;
      float l = dot(col, LUMA);
      col = mix(vec3(l), col, u_saturation);
      col = mix(col, vec3(l), u_gray);
      vec3 sep = vec3(dot(col, vec3(0.393, 0.769, 0.189)),
                      dot(col, vec3(0.349, 0.686, 0.168)),
                      dot(col, vec3(0.272, 0.534, 0.131)));
      col = mix(col, sep, u_sepia);
      col *= u_tint;
      l = clamp(dot(col, LUMA), 0.0, 1.0);
      col += (1.0 - l) * u_shadowTint + l * u_highTint;
      col = mix(col, col * 0.82 + 0.1, u_fade);

      if (u_palette > 0.5){
        vec2 cell = floor(q * u_pixel);
        float bx = mod(cell.x, 2.0);
        float by = mod(cell.y, 2.0);
        float bayer = bx * 2.0 + by * 3.0 - bx * by * 4.0;
        float g = clamp(dot(col, LUMA) + (bayer / 4.0 - 0.375) * 0.22, 0.0, 0.999);
        float idx = floor(g * 4.0);
        col = idx < 0.5 ? vec3(0.06, 0.22, 0.06)
            : idx < 1.5 ? vec3(0.19, 0.38, 0.19)
            : idx < 2.5 ? vec3(0.55, 0.67, 0.06)
            : vec3(0.61, 0.74, 0.06);
      }

      if (u_posterize > 0.0){
        float d = hash(floor(u_pixel.x > 0.0 ? q * u_pixel : gl_FragCoord.xy)) - 0.5;
        col = floor(col * u_posterize + 0.5 + d) / u_posterize;
      }

      if (u_leak > 0.0){
        vec2 c = vec2(0.92 + 0.08 * sin(t * 0.23), 0.12 + 0.18 * sin(t * 0.17));
        vec2 dv = (p - c) * vec2(u_res.x / u_res.y, 1.0);
        vec3 leakCol = mix(vec3(1.0, 0.32, 0.08), vec3(1.0, 0.72, 0.25), 0.5 + 0.5 * sin(t * 0.31));
        vec3 leak = leakCol * (1.0 - smoothstep(0.0, 1.0, length(dv))) * u_leak * (0.8 + 0.2 * sin(t * 0.9));
        col = 1.0 - (1.0 - clamp(col, 0.0, 1.0)) * (1.0 - leak);
      }

      if (u_vhs > 0.0){
        float n = hash(gl_FragCoord.xy + fract(t) * 997.0);
        col = mix(col, vec3(n), smoothstep(0.93, 1.0, p.y) * 0.55 * u_vhs);
        col += band * (n - 0.5) * 0.3 * u_vhs;
        col += step(0.996, hash(vec2(floor(p.y * 320.0), floor(t * 40.0)))) * 0.3 * u_vhs;
      }

      if (u_scratches > 0.0){
        for (int i = 0; i < 3; i++){
          float fi = float(i);
          float x = hash(vec2(frame, fi * 13.1 + 1.0));
          float show = step(0.5, hash(vec2(frame, fi * 7.7 + 2.0)));
          float w = 1.5 * u_pxScale / u_res.x;
          float scratch = (1.0 - smoothstep(0.0, w, abs(p.x - x))) * show;
          col = mix(col, vec3(0.92, 0.88, 0.78), scratch * u_scratches * 0.7);
        }
        float dust = step(0.9992, hash(floor(gl_FragCoord.xy / (3.0 * u_pxScale)) + frame * 17.0));
        col = mix(col, vec3(0.08), dust * u_scratches);
      }

      col *= 1.0 + (hash(vec2(frame, 3.0)) - 0.5) * u_flicker;

      if (u_scanlines > 0.0){
        col *= 1.0 - u_scanlines * (0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159 / max(1.5 * u_pxScale, 1.0)));
      }

      vec2 vc = (p - 0.5) * vec2(u_res.x / u_res.y, 1.0);
      col *= mix(1.0, 1.0 - smoothstep(0.2, 0.95, length(vc)), u_vignette);

      col += (hash(floor(gl_FragCoord.xy / max(u_pxScale, 1.0)) + fract(t * 7.13) * 311.0) - 0.5) * u_grain;

      gl_FragColor = vec4(mix(orig, clamp(col, 0.0, 1.0), u_mix), 1.0);
    }`;

  function createFilterRenderer(canvas){
    const gl = canvas.getContext("webgl", {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance"
    });
    if (!gl) return null;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, FILTER_VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FILTER_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // camera frames are rarely power-of-two sized: no mipmaps, clamp edges
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const locs = {};
    Object.keys(FILTER_DEFAULTS)
      .concat(["tex", "res", "uvScale", "uvOffset", "mirror", "time", "mix", "pxScale"])
      .forEach(k => { locs[k] = gl.getUniformLocation(prog, "u_" + k); });
    gl.uniform1i(locs.tex, 0);

    let srcW = 1, srcH = 1;
    return {
      upload(source, w, h){
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
        srcW = w || 1; srcH = h || 1;
      },
      draw(filter, { time = 0, mix = 1, mirror = false } = {}){
        if (gl.isContextLost()) return false;
        const W = canvas.width, H = canvas.height;
        gl.viewport(0, 0, W, H);
        // same crop as CSS object-fit: cover
        const va = W/H, ta = srcW/srcH;
        const sx = va > ta ? 1 : va/ta;
        const sy = va > ta ? ta/va : 1;
        gl.uniform2f(locs.uvScale, sx, sy);
        gl.uniform2f(locs.uvOffset, (1-sx)/2, (1-sy)/2);
        gl.uniform2f(locs.res, W, H);
        gl.uniform1f(locs.mirror, mirror ? 1 : 0);
        gl.uniform1f(locs.time, time);
        gl.uniform1f(locs.mix, mix);
        gl.uniform1f(locs.pxScale, W/720);
        for (const key in FILTER_DEFAULTS){
          const v = key in filter.p ? filter.p[key] : FILTER_DEFAULTS[key];
          if (!Array.isArray(v)) gl.uniform1f(locs[key], v);
          else if (v.length === 3) gl.uniform3fv(locs[key], v);
          else gl.uniform2fv(locs[key], v);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return true;
      }
    };
  }


  global.FiltrosCam = { FILTERS, FILTER_BY_ID, FILTER_DEFAULTS, createFilterRenderer };
})(window);
