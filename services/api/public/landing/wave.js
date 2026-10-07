/*
 * Landing hero background: a slow silk band in Zold pinks over neutrals, drawn by a
 * small fragment shader at half resolution (the CSS blur on .l-wave softens the
 * rest). No WebGL: a static pink glow. Reduced motion: one still frame. The loop
 * runs only while the canvas is on screen and motion is not paused.
 */
(function () {
  var canvas = document.querySelector(".l-wave");
  if (!canvas) return;
  var FALLBACK = "radial-gradient(60% 40% at 40% 80%, color-mix(in srgb, var(--z-pink) 35%, transparent), transparent 70%)";
  var gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
  if (!gl) { canvas.style.background = FALLBACK; return; }

  var RENDER_SCALE = 0.5;
  var STILL_FRAME_MS = 12000;
  var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  var VERT = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }";
  var FRAG = [
    "precision mediump float;",
    "uniform vec2 res; uniform float t;",
    "uniform vec3 cA, cB, cC, cD, cR, cBg;",
    "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
    "float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);",
    "  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }",
    "float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 4; i++){ v += a*noise(p); p *= 2.; a *= .5; } return v; }",
    "void main(){",
    "  vec2 uv = gl_FragCoord.xy / res;",
    "  float x = uv.x * res.x / res.y;",
    "  float w = .30 + .07*sin(x*1.2 + t*.22) + .04*sin(x*2.9 - t*.17) + .06*(fbm(vec2(x*.7, t*.04)) - .5);",
    "  float d = uv.y - w;",
    "  float body = exp(-d*d*90.) * .55;",
    "  float glow = exp(-d*d*14.) * .18;",
    "  float f1 = exp(-pow(d + .020, 2.) * 3200.);",
    "  float f2 = exp(-pow(d - .030 - .020*sin(x*3.1 + t*.30), 2.) * 1400.) * .55;",
    "  float f3 = exp(-pow(d - .075 - .030*sin(x*1.7 - t*.24), 2.) * 700.) * .35;",
    "  float crease = .35 + .65 * smoothstep(-.6, .9, sin(x*5.5 + d*55. + t*.35 + fbm(vec2(x*2., t*.1))*3.));",
    "  float hue = fbm(vec2(x*.5 + t*.02, uv.y*1.6));",
    "  float side = smoothstep(.25, .75, uv.x + (hue - .5) * .5 + .06*sin(t*.15));",
    "  vec3 col = mix(cA, cB, side);",
    "  col = mix(col, cC, smoothstep(.55, .85, hue) * .7);",
    "  col = mix(col, cD, smoothstep(.38, .22, hue) * (1. - side) * .5);",
    "  vec3 c = col * (body*crease + glow + f2*crease + f3) + mix(cR, col, .35) * f1 * (.5 + .5*crease);",
    "  c *= 1. - smoothstep(.42, .72, uv.y);",
    "  gl_FragColor = vec4(cBg + c, 1.);",
    "}"
  ].join("\n");

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
    return s;
  }
  var prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link failed");
  } catch (err) {
    console.error("landing wave:", err);
    canvas.style.background = FALLBACK;
    return;
  }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var uRes = gl.getUniformLocation(prog, "res");
  var uT = gl.getUniformLocation(prog, "t");

  // Colours come from the page tokens, so the wave follows the palette. cBg is the
  // page background the band is added onto, so the canvas edge leaves no seam.
  var COLOURS = [["cBg", "--z-bg"], ["cA", "--z-pink"], ["cB", "--l-art-b"], ["cC", "--l-art-c"], ["cD", "--l-art-d"], ["cR", "--l-art-ridge"]];
  function hexToVec(hex) {
    var h = String(hex).trim().replace("#", "");
    if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
    var n = parseInt(h, 16);
    if (h.length !== 6 || isNaN(n)) return [0.93, 0.09, 0.55];
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  var css = getComputedStyle(document.body);
  COLOURS.forEach(function (c) { gl.uniform3fv(gl.getUniformLocation(prog, c[0]), hexToVec(css.getPropertyValue(c[1]))); });

  function resize() {
    var r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * RENDER_SCALE));
    canvas.height = Math.max(1, Math.round(r.height * RENDER_SCALE));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  function draw(ms) {
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uT, ms / 1000);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  resize();
  if (REDUCED) {
    draw(STILL_FRAME_MS);
    addEventListener("resize", function () { resize(); draw(STILL_FRAME_MS); });
    return;
  }
  addEventListener("resize", resize);

  // Runs while on screen and not paused (the hero's Pause motion button, motion.js).
  var raf = 0, onScreen = false;
  function loop(ms) { draw(ms); raf = requestAnimationFrame(loop); }
  function run() {
    var go = onScreen && !document.documentElement.classList.contains("l-paused");
    if (go && !raf) raf = requestAnimationFrame(loop);
    if (!go) { cancelAnimationFrame(raf); raf = 0; }
  }
  new IntersectionObserver(function (entries) { onScreen = entries[0].isIntersecting; run(); }).observe(canvas);
  document.addEventListener("l-motion", run);
})();
