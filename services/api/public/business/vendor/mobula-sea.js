var Mobula = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // design/agentic/vendor/src/engine.ts
  var engine_exports = {};
  __export(engine_exports, {
    Sea: () => Sea
  });

  // design/agentic/vendor/src/rays.ts
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var scatter = (rng, inside, n, box, r, c, a = 1) => {
    const out = [];
    for (let tries = 0; out.length < n && tries < n * 40; tries++) {
      const x = box[0] + rng() * (box[1] - box[0]);
      const y = (rng() * 2 - 1) * box[2];
      if (!inside(x, y)) continue;
      const rr = r[0] + rng() * (r[1] - r[0]);
      if (out.some((m) => Math.hypot(m.x - x, m.y - y) < (m.r + rr) * 1.25)) continue;
      out.push({ x, y, r: rr, c, a });
    }
    return out;
  };
  var narwhal = (palette) => ({
    outline: [
      [0.5, 0],
      [0.48, 0.08],
      [0.42, 0.15],
      [0.3, 0.2],
      [0.16, 0.22],
      [0.1, 0.3],
      [0.02, 0.36],
      [-0.04, 0.33],
      [-0.02, 0.23],
      [-0.14, 0.19],
      [-0.28, 0.12],
      [-0.38, 0.07],
      [-0.44, 0.12],
      [-0.52, 0.24],
      [-0.57, 0.22],
      [-0.53, 0.08],
      [-0.5, 0.03]
    ],
    bodyHalf: 0.2,
    mode: "undulate",
    amp: 0.7,
    rate: 2.6,
    lag: 1.1,
    glide: false,
    tailLen: 0.01,
    tailW: 0,
    barb: 0,
    tusk: 0.5,
    eyes: [0.34, 0.13],
    speed: 0.04,
    turnRate: 0.7,
    palette,
    marks: (rng, inside) => [
      ...scatter(rng, inside, 9, [-0.35, 0.4, 0.2], [0.03, 0.06], "dark", 0.75),
      ...scatter(rng, inside, 12, [-0.35, 0.42, 0.2], [0.016, 0.03], "light", 0.8)
    ]
  });
  var SPECIES = {
    narwhal: narwhal({ base: "#7f8a9c", ridge: "#39414f", tail: "#5d6777", dark: "#4a5363", light: "#d5dae2", tusk: "#ede6d6" }),
    narwhalPale: narwhal({ base: "#c2c5c9", ridge: "#6e7480", tail: "#9a9ea6", dark: "#8a8f99", light: "#f1ede4", tusk: "#ede6d6" }),
    narwhalDark: narwhal({ base: "#34507c", ridge: "#172741", tail: "#263c60", dark: "#1f3254", light: "#9fb4d6", tusk: "#ede6d6" }),
    // Blue-spotted ribbontail: an amber oval disc with electric-cobalt spots and a cobalt-edged tail.
    ribbontail: {
      outline: [
        [0.5, 0],
        [0.47, 0.13],
        [0.38, 0.26],
        [0.22, 0.355],
        [0.04, 0.385],
        [-0.14, 0.37],
        [-0.3, 0.3],
        [-0.42, 0.19],
        [-0.48, 0.1],
        [-0.5, 0.035]
      ],
      bodyHalf: 0.13,
      mode: "undulate",
      amp: 0.6,
      rate: 3.1,
      lag: 1.4,
      glide: false,
      tailLen: 0.95,
      tailW: 0.06,
      barb: 0.34,
      ribbon: true,
      eyes: [0.3, 0.075],
      speed: 0.036,
      turnRate: 0.85,
      palette: { base: "#8c6a3c", ridge: "#3a2a18", tail: "#6e5232", spot: "#3d84ff", ribbon: "#3d84ff" },
      marks: (rng, inside) => scatter(rng, inside, 15, [-0.42, 0.42, 0.34], [0.022, 0.042], "spot")
    },
    // Spotted eagle ray: a swept diamond with a duck-bill head, pale spots on cobalt ink, a whip of a tail.
    eagle: {
      outline: [
        [0.62, 0],
        [0.6, 0.045],
        [0.54, 0.07],
        [0.47, 0.085],
        [0.4, 0.15],
        [0.28, 0.36],
        [0.14, 0.6],
        [0.01, 0.81],
        [-0.06, 0.87],
        [-0.11, 0.8],
        [-0.2, 0.55],
        [-0.31, 0.33],
        [-0.42, 0.16],
        [-0.5, 0.05]
      ],
      bodyHalf: 0.12,
      mode: "flap",
      amp: 0.95,
      rate: 2.5,
      lag: 1.4,
      glide: true,
      tailLen: 1.8,
      tailW: 0.035,
      barb: 0.12,
      eyes: [0.5, 0.075],
      speed: 0.046,
      turnRate: 0.7,
      palette: { base: "#22386a", ridge: "#101a33", tail: "#1b2a4f", spot: "#e8d9b8" },
      marks: (rng, inside) => [
        ...scatter(rng, inside, 26, [-0.4, 0.42, 0.82], [0.018, 0.034], "spot"),
        ...scatter(rng, inside, 8, [-0.3, 0.3, 0.6], [0.035, 0.05], "spot", 0.85)
      ]
    },
    // Manta: the big slow one, wide swept wings, cephalic fins either side of the mouth, pale shoulder chevrons.
    manta: {
      outline: [
        [0.44, 0],
        [0.45, 0.07],
        [0.55, 0.1],
        [0.555, 0.135],
        [0.47, 0.165],
        [0.38, 0.21],
        [0.25, 0.42],
        [0.09, 0.74],
        [-0.08, 0.98],
        [-0.15, 1.02],
        [-0.19, 0.95],
        [-0.23, 0.7],
        [-0.31, 0.44],
        [-0.41, 0.22],
        [-0.5, 0.07]
      ],
      bodyHalf: 0.17,
      mode: "flap",
      amp: 0.8,
      rate: 1.5,
      lag: 1.2,
      glide: false,
      tailLen: 0.5,
      tailW: 0.04,
      barb: 0,
      eyes: [0.4, 0.18],
      speed: 0.028,
      turnRate: 0.42,
      palette: { base: "#1e2d4d", ridge: "#0e1628", tail: "#18223b", patch: "#c9cfdd" },
      marks: () => [
        { x: 0.2, y: 0.3, r: 0.12, c: "patch", a: 0.9 },
        { x: 0.2, y: -0.3, r: 0.12, c: "patch", a: 0.9 },
        { x: 0.06, y: 0.47, r: 0.1, c: "patch", a: 0.75 },
        { x: 0.06, y: -0.47, r: 0.1, c: "patch", a: 0.75 },
        { x: -0.08, y: 0.62, r: 0.07, c: "patch", a: 0.5 },
        { x: -0.08, y: -0.62, r: 0.07, c: "patch", a: 0.5 }
      ]
    },
    // Round stingray: a sandy, mottled near-circle with a little paddle on the tail. Settles on the sand.
    round: {
      outline: [
        [0.5, 0],
        [0.48, 0.14],
        [0.4, 0.29],
        [0.25, 0.4],
        [0.06, 0.45],
        [-0.12, 0.44],
        [-0.28, 0.37],
        [-0.39, 0.27],
        [-0.44, 0.2],
        [-0.43, 0.15],
        [-0.47, 0.12],
        [-0.5, 0.05]
      ],
      bodyHalf: 0.14,
      mode: "undulate",
      amp: 0.5,
      rate: 2.4,
      lag: 1.2,
      glide: false,
      tailLen: 0.85,
      tailW: 0.055,
      barb: 0.45,
      paddle: true,
      eyes: [0.3, 0.08],
      speed: 0.03,
      turnRate: 0.8,
      rests: true,
      palette: { base: "#7a5b37", ridge: "#3e2e1b", tail: "#5e462b", dark: "#4e3a22", light: "#b08f60" },
      marks: (rng, inside) => [
        ...scatter(rng, inside, 7, [-0.38, 0.4, 0.4], [0.05, 0.09], "dark", 0.8),
        ...scatter(rng, inside, 6, [-0.38, 0.4, 0.4], [0.04, 0.07], "light", 0.7)
      ]
    },
    // Mobula: small devil rays that travel in a school, quick wingbeats, dark wingtips.
    mobula: {
      outline: [
        [0.46, 0],
        [0.47, 0.06],
        [0.58, 0.085],
        [0.57, 0.11],
        [0.47, 0.13],
        [0.36, 0.2],
        [0.22, 0.42],
        [0.07, 0.72],
        [-0.07, 0.94],
        [-0.13, 0.97],
        [-0.17, 0.9],
        [-0.22, 0.66],
        [-0.31, 0.4],
        [-0.42, 0.19],
        [-0.5, 0.06]
      ],
      bodyHalf: 0.15,
      mode: "flap",
      amp: 1,
      rate: 4.4,
      lag: 1,
      glide: false,
      tailLen: 0.95,
      tailW: 0.025,
      barb: 0,
      eyes: [0.4, 0.16],
      speed: 0.06,
      turnRate: 1.4,
      palette: { base: "#2b4a86", ridge: "#132544", tail: "#1d3260", tip: "#142443" },
      marks: () => [
        { x: -0.1, y: 0.88, r: 0.2, c: "tip", a: 0.9 },
        { x: -0.1, y: -0.88, r: 0.2, c: "tip", a: 0.9 }
      ]
    },
    // Cownose ray: golden sand, a notched two-lobed head, beats in bursts like the eagle ray.
    cownose: {
      outline: [
        [0.5, 0],
        [0.56, 0.035],
        [0.555, 0.075],
        [0.48, 0.1],
        [0.37, 0.19],
        [0.23, 0.4],
        [0.07, 0.66],
        [-0.05, 0.8],
        [-0.11, 0.79],
        [-0.19, 0.6],
        [-0.3, 0.36],
        [-0.41, 0.17],
        [-0.5, 0.05]
      ],
      bodyHalf: 0.13,
      mode: "flap",
      amp: 0.85,
      rate: 2.2,
      lag: 1.3,
      glide: true,
      tailLen: 1.2,
      tailW: 0.03,
      barb: 0.14,
      eyes: [0.48, 0.09],
      speed: 0.04,
      turnRate: 0.7,
      palette: { base: "#a8834f", ridge: "#4a3519", tail: "#7c5f36", tip: "#6e522d" },
      marks: () => [
        { x: -0.08, y: 0.74, r: 0.15, c: "tip", a: 0.7 },
        { x: -0.08, y: -0.74, r: 0.15, c: "tip", a: 0.7 }
      ]
    },
    // Butterfly ray: a very wide, short-tailed disc in cobalt-grey, freckled with sand. Ripples its margin.
    butterfly: {
      outline: [
        [0.5, 0],
        [0.48, 0.12],
        [0.4, 0.3],
        [0.28, 0.55],
        [0.12, 0.85],
        [0, 1],
        [-0.08, 1.02],
        [-0.14, 0.9],
        [-0.22, 0.6],
        [-0.32, 0.36],
        [-0.42, 0.18],
        [-0.5, 0.05]
      ],
      bodyHalf: 0.14,
      mode: "undulate",
      amp: 0.55,
      rate: 2,
      lag: 0.9,
      glide: false,
      tailLen: 0.35,
      tailW: 0.03,
      barb: 0,
      eyes: [0.33, 0.07],
      speed: 0.033,
      turnRate: 0.7,
      palette: { base: "#3a4f7e", ridge: "#1c2846", tail: "#2c3d63", fleck: "#d8bf8f", dark: "#25355a" },
      marks: (rng, inside) => [
        ...scatter(rng, inside, 6, [-0.3, 0.35, 0.8], [0.05, 0.08], "dark", 0.7),
        ...scatter(rng, inside, 22, [-0.35, 0.42, 0.95], [0.014, 0.026], "fleck", 0.85)
      ]
    }
  };
  var SUB = 7;
  var shapes = /* @__PURE__ */ new Map();
  function shapeOf(sp) {
    const cached = shapes.get(sp);
    if (cached) return cached;
    const def = SPECIES[sp];
    const pts = def.outline;
    const n = pts.length;
    const P = [[pts[1][0], -pts[1][1]], ...pts, [pts[n - 2][0], -pts[n - 2][1]]];
    const hx = [];
    const hy = [];
    for (let i = 1; i < P.length - 2; i++) {
      const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
      for (let s = 0; s < SUB; s++) {
        const t = s / SUB;
        const t2 = t * t;
        const t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        hx.push(f(p0[0], p1[0], p2[0], p3[0]));
        hy.push(Math.max(0, f(p0[1], p1[1], p2[1], p3[1])));
      }
    }
    hx.push(pts[n - 1][0]);
    hy.push(pts[n - 1][1]);
    const m = hx.length;
    const lx = new Float32Array(m * 2);
    const ly = new Float32Array(m * 2);
    for (let i = 0; i < m; i++) {
      lx[i] = hx[i];
      ly[i] = hy[i];
      lx[m * 2 - 1 - i] = hx[i];
      ly[m * 2 - 1 - i] = -hy[i];
    }
    const edge = def.bodyHalf * 0.9;
    const idx = [];
    for (let i = 0; i < m; i++) if (hy[i] >= edge) idx.push(i);
    const wxs = idx.map((i) => hx[i]);
    const wys = idx.map((i) => hy[i]);
    if (idx.length) {
      const x0 = hx[idx[0]];
      const x1 = hx[idx[idx.length - 1]];
      for (let k = 1; k < 8; k++) {
        wxs.push(x1 + (x0 - x1) * k / 8);
        wys.push(edge);
      }
    }
    const inside = (x, y) => {
      let c = false;
      for (let i = 0, j = lx.length - 1; i < lx.length; j = i++) {
        if (ly[i] > y !== ly[j] > y && x < (lx[j] - lx[i]) * (y - ly[i]) / (ly[j] - ly[i]) + lx[i]) c = !c;
      }
      return c;
    };
    const shape = { lx, ly, wx: Float32Array.from(wxs), wy: Float32Array.from(wys), span: Math.max(...hy), inside };
    shapes.set(sp, shape);
    return shape;
  }

  // design/agentic/vendor/src/engine.ts
  var SS = 3;
  var TAU = Math.PI * 2;
  var TAIL_N = 18;
  var LOOK = {
    app: { cell: 12, water: [7, 8, 11], grid: "rgba(196,206,226,0.045)", ripple: [214, 184, 134], snow: [150, 162, 186], snow_n: 30, backDepth: 0.6, pace: 1 },
    paper: { cell: 15, water: [239, 235, 228], grid: null, ripple: [176, 152, 118], snow: [160, 150, 132], snow_n: 16, backDepth: 2, pace: 0.7 }
  };
  var FULL = [":", ";", "t", "o", "S", "X", "%", "#", "8", "@"];
  var MID = [":", ";", "o", "t", "."];
  var EDGE = ["'", ",", ".", "`", "'"];
  var PUFF = ["\xB7", ".", "o", "\xB0"];
  var SNOW = ["-", "\xB7", "'", "-", "."];
  var ACCENTS = ["#e9c48f", "#6f9dff", "#f08a5d", "#b9a4ff"];
  var clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  var wrapAngle = (a) => {
    while (a > Math.PI) a -= TAU;
    while (a < -Math.PI) a += TAU;
    return a;
  };
  var hash = (x, y, z) => {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647);
    h = Math.imul(h ^ h >>> 13, 1274126177);
    return ((h ^ h >>> 16) >>> 0) / 4294967296;
  };
  var hexRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  };
  var mixHex = (hex, to, k) => {
    const [r, g, b] = hexRgb(hex);
    return `rgb(${Math.round(r + (to[0] - r) * k)},${Math.round(g + (to[1] - g) * k)},${Math.round(b + (to[2] - b) * k)})`;
  };
  var smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  var shade = (v) => v > 0 ? `rgba(4,5,9,${(0.46 * v).toFixed(3)})` : `rgba(255,250,240,${(-0.2 * v).toFixed(3)})`;
  var CAST = {
    // The app's rays circle the prompt card. Order = order round the ring (big and small alternate); the deep
    // ones (≥ 0.6, blurred) take the outer lanes and run partly off the sides.
    app: [
      { sp: "narwhalDark", L: 0.3, depth: 0.82, x: 0.5, y: 0.5, lane: 1 },
      { sp: "narwhalPale", L: 0.2, depth: 0.08, x: 0.5, y: 0.5, lane: 0.15 },
      { sp: "narwhal", L: 0.22, depth: 0.16, x: 0.5, y: 0.5, lane: 0.6 },
      { sp: "narwhalDark", L: 0.18, depth: 0.3, x: 0.5, y: 0.5, lane: 0.25 },
      ...[0, 1, 2, 3].map((i) => ({ sp: "narwhal", L: 0.1 - i * 4e-3, depth: 0.22 + i * 0.05, x: 0.5, y: 0.5, school: 0, lane: 0.42 })),
      { sp: "narwhalPale", L: 0.24, depth: 0.66, x: 0.5, y: 0.5, lane: 0.9 },
      { sp: "narwhal", L: 0.19, depth: 0.12, x: 0.5, y: 0.5, lane: 0.35 }
    ],
    paper: [
      { sp: "eagle", L: 0.22, depth: 0.2, x: 0.1, y: 0.32, heading: 0.3 },
      { sp: "manta", L: 0.26, depth: 0.35, x: 0.88, y: 0.7, heading: 3.4 },
      { sp: "ribbontail", L: 0.18, depth: 0.1, x: 0.92, y: 0.16, heading: 2.4 },
      { sp: "round", L: 0.16, depth: 0.25, x: 0.07, y: 0.82, heading: -0.6 },
      ...[0, 1, 2, 3, 4].map((i) => ({ sp: "mobula", L: 0.06 - i * 25e-4, depth: 0.15 + i * 0.05, x: 0.5, y: 0.95, school: 0 }))
    ]
  };
  var SLOTS = [
    [0, 0],
    [-1.5, -1.2],
    [-1.6, 1.25],
    [-3, -2.2],
    [-3.1, 0.1],
    [-3, 2.3]
  ];
  var SLOT_K = 1.35;
  var ORBIT_DIR = -1;
  var ORBIT_W = 0.075;
  var School = class {
    constructor(x, y, speed, rng) {
      __publicField(this, "rng", rng);
      __publicField(this, "x");
      __publicField(this, "y");
      __publicField(this, "heading");
      __publicField(this, "speed");
      __publicField(this, "base");
      __publicField(this, "boost", 1);
      __publicField(this, "tx", 0);
      __publicField(this, "ty", 0);
      __publicField(this, "targetAge", 0);
      __publicField(this, "lane", null);
      __publicField(this, "slotAngle", 0);
      this.x = x;
      this.y = y;
      this.heading = rng() * TAU;
      this.speed = speed;
      this.base = speed;
    }
    retarget(sea) {
      const A = sea.A;
      const inside = this.x > 0 && this.x < A && this.y > 0 && this.y < 1;
      if (inside && this.rng() < 0.35) {
        const side = Math.floor(this.rng() * 4);
        const t = 0.1 + this.rng() * 0.8;
        this.tx = side === 0 ? -0.35 : side === 1 ? A + 0.35 : t * A;
        this.ty = side === 2 ? -0.35 : side === 3 ? 1.35 : t;
      } else {
        this.tx = (0.1 + this.rng() * 0.8) * A;
        this.ty = 0.1 + this.rng() * 0.8;
      }
      this.targetAge = 0;
    }
    place(x, y, heading) {
      this.x = x;
      this.y = y;
      this.heading = heading;
    }
    update(dt, t, sea) {
      let gx = this.tx;
      let gy = this.ty;
      let pace = this.base;
      if (this.lane !== null) {
        const o = sea.orbitGoal(this.x, this.y, this.lane, this.slotAngle, 7.3);
        gx = o.gx;
        gy = o.gy;
        pace = o.speed;
      }
      let sx = gx - this.x;
      let sy = gy - this.y;
      const d = Math.hypot(sx, sy) || 1;
      sx /= d;
      sy /= d;
      if (this.lane !== null) {
        const [kx, ky] = sea.keepOut(this.x, this.y, 0.16);
        sx += kx;
        sy += ky;
      }
      if (sea.pointer) {
        const dx = this.x - sea.pointer.x;
        const dy = this.y - sea.pointer.y;
        const pd = Math.hypot(dx, dy);
        if (pd < 0.22 && pd > 1e-4) {
          const w = 1 - pd / 0.22;
          sx += dx / pd * w * 3;
          sy += dy / pd * w * 3;
          this.boost = Math.max(this.boost, 1 + w);
        }
      }
      const want = Math.atan2(sy, sx);
      const turn = 0.75 + Math.sin(t * 0.5) * 0.15;
      this.heading = wrapAngle(this.heading + clamp(wrapAngle(want - this.heading) * 1.1, -turn, turn) * dt);
      this.boost = 1 + (this.boost - 1) * Math.exp(-dt * 0.7);
      this.speed += (pace * this.boost - this.speed) * Math.min(1, dt * 2);
      this.x += Math.cos(this.heading) * this.speed * dt;
      this.y += Math.sin(this.heading) * this.speed * dt;
      if (this.lane !== null) return;
      this.targetAge += dt;
      const far = this.x < -0.7 || this.x > sea.A + 0.7 || this.y < -0.7 || this.y > 1.7;
      if (Math.hypot(this.tx - this.x, this.ty - this.y) < 0.12 || far || this.targetAge > 18) this.retarget(sea);
    }
  };
  var Ray = class {
    constructor(spec, A, look, rng, school, slotIndex) {
      __publicField(this, "def");
      __publicField(this, "shape");
      __publicField(this, "L");
      __publicField(this, "depth");
      /** Body radius in world units (wingtips, or nose to tail root for the long-bodied ones): nothing may come closer. */
      __publicField(this, "R");
      /** Carousel lane and slot (app), or null to roam freely (paper). */
      __publicField(this, "lane");
      __publicField(this, "slotAngle", 0);
      __publicField(this, "marks");
      __publicField(this, "pal");
      __publicField(this, "school");
      __publicField(this, "slot");
      __publicField(this, "seed");
      __publicField(this, "x");
      __publicField(this, "y");
      __publicField(this, "heading");
      __publicField(this, "speed");
      __publicField(this, "base");
      __publicField(this, "boost", 1);
      __publicField(this, "turn", 0);
      __publicField(this, "bank", 0);
      __publicField(this, "phase");
      __publicField(this, "ampK", 1);
      __publicField(this, "tx", 0);
      __publicField(this, "ty", 0);
      __publicField(this, "targetAge", 0);
      __publicField(this, "rest", 0);
      __publicField(this, "restCool");
      __publicField(this, "qx", new Float32Array(TAIL_N + 1));
      __publicField(this, "qy", new Float32Array(TAIL_N + 1));
      __publicField(this, "rng");
      __publicField(this, "P", [0, 0]);
      this.def = SPECIES[spec.sp];
      this.shape = shapeOf(spec.sp);
      this.rng = mulberry32(Math.floor(rng() * 1e9));
      this.L = spec.L;
      this.depth = spec.depth;
      this.R = Math.max(this.shape.span, 0.55) * spec.L;
      this.lane = school ? null : spec.lane ?? null;
      this.seed = this.rng() * 100;
      this.marks = this.def.marks(this.rng, this.shape.inside);
      const haze = spec.depth * (look.water[0] > 128 ? 0.4 : 0.55);
      this.pal = Object.fromEntries(Object.entries(this.def.palette).map(([k, v]) => [k, mixHex(v, look.water, haze)]));
      this.school = school;
      this.slot = SLOTS[slotIndex % SLOTS.length];
      this.x = spec.x * A + (school ? this.slot[0] * spec.L * 0.9 : 0);
      this.y = spec.y + (school ? this.slot[1] * spec.L * 0.9 : 0);
      this.heading = spec.heading ?? (school ? school.heading : this.rng() * TAU);
      this.base = this.def.speed * look.pace * (1 - spec.depth * 0.25);
      this.speed = this.base;
      this.phase = this.rng() * TAU;
      this.restCool = 8 + this.rng() * 10;
      this.place(this.x, this.y, this.heading);
    }
    /** Put the ray somewhere, tail laid out straight behind it. */
    place(x, y, heading) {
      this.x = x;
      this.y = y;
      this.heading = heading;
      const c = Math.cos(heading);
      const s = Math.sin(heading);
      const seg = this.def.tailLen * this.L / TAIL_N;
      for (let i = 0; i <= TAIL_N; i++) {
        this.qx[i] = x - c * (0.49 * this.L + seg * i);
        this.qy[i] = y - s * (0.49 * this.L + seg * i);
      }
    }
    /** Line up in this ray's slot behind its school's leader. */
    placeInSchool() {
      const sc = this.school;
      if (!sc) return;
      const c = Math.cos(sc.heading);
      const s = Math.sin(sc.heading);
      const ox = this.slot[0] * this.L * SLOT_K;
      const oy = this.slot[1] * this.L * SLOT_K;
      this.place(sc.x + ox * c - oy * s, sc.y + ox * s + oy * c, sc.heading);
    }
    retarget(sea) {
      const A = sea.A;
      const inside = this.x > 0 && this.x < A && this.y > 0 && this.y < 1;
      for (let tries = 0; tries < 12; tries++) {
        let x;
        let y;
        if (sea.attentive) {
          const a = this.rng() * TAU;
          const r = 0.22 + this.rng() * 0.18;
          x = sea.fc.x + Math.cos(a) * r * (A > 1.2 ? 1.7 : 1);
          y = sea.fc.y + Math.sin(a) * r * 0.85;
        } else if (inside && this.rng() < 0.36) {
          const side = Math.floor(this.rng() * 4);
          const t = 0.1 + this.rng() * 0.8;
          x = side === 0 ? -0.4 : side === 1 ? A + 0.4 : t * A;
          y = side === 2 ? -0.4 : side === 3 ? 1.4 : t;
        } else {
          x = (0.1 + this.rng() * 0.8) * A;
          y = 0.1 + this.rng() * 0.8;
        }
        const crowded = sea.rays.some((o) => o !== this && !o.school && Math.hypot(x - o.tx, y - o.ty) < 0.3);
        if (Math.hypot(x - this.x, y - this.y) > 0.35 && !crowded || tries === 11) {
          this.tx = x;
          this.ty = y;
          this.targetAge = 0;
          return;
        }
      }
    }
    update(dt, t, sea) {
      const def = this.def;
      let gx = this.tx;
      let gy = this.ty;
      const sc = this.school;
      if (sc) {
        const c = Math.cos(sc.heading);
        const s = Math.sin(sc.heading);
        const ox = (this.slot[0] + Math.sin(t * 0.6 + this.seed) * 0.2) * this.L * SLOT_K;
        const oy = (this.slot[1] + Math.cos(t * 0.5 + this.seed) * 0.2) * this.L * SLOT_K;
        gx = sc.x + ox * c - oy * s;
        gy = sc.y + ox * s + oy * c;
      }
      let orbitPace = 0;
      if (this.lane !== null) {
        const o = sea.orbitGoal(this.x, this.y, this.lane, this.slotAngle, this.seed);
        gx = o.gx;
        gy = o.gy;
        orbitPace = o.speed;
      }
      const gd = Math.hypot(gx - this.x, gy - this.y) || 1;
      let sx = (gx - this.x) / gd;
      let sy = (gy - this.y) / gd;
      if (sea.pointer && this.depth < 0.7) {
        const dx = this.x - sea.pointer.x;
        const dy = this.y - sea.pointer.y;
        const d = Math.hypot(dx, dy);
        const reach = 0.14 + this.R * 0.6;
        if (d < reach && d > 1e-4) {
          const w2 = 1 - d / reach;
          sx += dx / d * w2 * 3;
          sy += dy / d * w2 * 3;
          this.boost = Math.max(this.boost, 1 + w2 * 1.3);
          if (this.rest > 0) this.liftOff(sea);
        }
      }
      if (this.lane !== null || sc !== null && sc.lane !== null) {
        const [kx, ky] = sea.keepOut(this.x, this.y, this.R);
        sx += kx;
        sy += ky;
      }
      const hx0 = Math.cos(this.heading);
      const hy0 = Math.sin(this.heading);
      let threat = 0;
      for (const o of sea.rays) {
        if (o === this) continue;
        const mates = sc !== null && o.school === sc;
        const reach = (this.R + o.R) * (mates ? 0.85 : 1.25) + 0.03;
        for (let p = 0; p < 2; p++) {
          const px = this.x + hx0 * this.L * 0.6 * p;
          const py = this.y + hy0 * this.L * 0.6 * p;
          const dx = px - o.x;
          const dy = py - o.y;
          const d = Math.hypot(dx, dy);
          if (d >= reach || d < 1e-5) continue;
          const w2 = 1 - d / reach;
          const push = w2 * w2 * (p === 0 ? 3.4 : 2.2);
          sx += dx / d * push;
          sy += dy / d * push;
          threat = Math.max(threat, w2);
        }
        if (mates) continue;
        const rt = this.R * 0.9 + 0.02;
        for (let i = 6; i <= TAIL_N; i += 6) {
          const dx = this.x - o.qx[i];
          const dy = this.y - o.qy[i];
          const d = Math.hypot(dx, dy);
          if (d >= rt || d < 1e-5) continue;
          const w2 = 1 - d / rt;
          sx += dx / d * w2 * w2 * 1.6;
          sy += dy / d * w2 * w2 * 1.6;
          threat = Math.max(threat, w2 * 0.6);
        }
      }
      let desired = Math.atan2(sy, sx);
      if (sc && gd < this.L * 1.6 && threat < 0.3) {
        const k = gd / (this.L * 1.6);
        desired = sc.heading + wrapAngle(desired - sc.heading) * k;
      }
      const resting = this.rest > 0;
      const maxTurn = def.turnRate * (1 + threat * 1.6) * (resting ? 0.15 : 1);
      const wander = sc ? 0 : (Math.sin(t * 0.37 + this.seed) * 0.1 + Math.sin(t * 0.91 + this.seed * 2) * 0.05) * (this.lane !== null ? 0.4 : 1);
      const prev = this.heading;
      this.heading = wrapAngle(this.heading + clamp(wrapAngle(desired - this.heading) * 1.1 + wander, -maxTurn, maxTurn) * dt);
      const w = wrapAngle(this.heading - prev) / Math.max(dt, 1e-4);
      this.turn += (w - this.turn) * Math.min(1, dt * 3);
      this.bank = clamp(this.turn / def.turnRate, -1, 1);
      this.boost = 1 + (this.boost - 1) * Math.exp(-dt * 0.75);
      const catchUp = sc ? clamp(0.92 + gd / (this.L * 2), 0.6, 2.2) * (sc.speed / Math.max(1e-4, this.base)) : 1;
      const target = (this.lane !== null ? orbitPace : this.base * catchUp) * this.boost * (resting ? 0.03 : 1);
      this.speed += (target - this.speed) * Math.min(1, dt * (resting ? 1.2 : 2));
      this.x += hx0 * this.speed * dt;
      this.y += hy0 * this.speed * dt;
      const env = def.glide ? 0.28 + 0.72 * smooth(-0.15, 0.6, Math.sin(t * 0.45 + this.seed)) : 1;
      this.ampK += (env * (resting ? 0.25 : 1) * (this.boost > 1.3 ? 1.15 : 1) - this.ampK) * Math.min(1, dt * 1.5);
      this.phase += dt * def.rate * (0.65 + 0.35 * this.boost) * (resting ? 0.4 : 1);
      const seg = def.tailLen * this.L / TAIL_N;
      this.qx[0] = this.x - hx0 * 0.49 * this.L;
      this.qy[0] = this.y - hy0 * 0.49 * this.L;
      let prevA = this.heading + Math.PI;
      for (let i = 1; i <= TAIL_N; i++) {
        let a = Math.atan2(this.qy[i] - this.qy[i - 1], this.qx[i] - this.qx[i - 1]);
        const bend = wrapAngle(a - prevA);
        const cap = i === 1 ? 0.06 : 0.16;
        if (Math.abs(bend) > cap) a = prevA + Math.sign(bend) * cap;
        this.qx[i] = this.qx[i - 1] + Math.cos(a) * seg;
        this.qy[i] = this.qy[i - 1] + Math.sin(a) * seg;
        prevA = a;
      }
      if (def.rests && this.lane === null) {
        if (resting) {
          this.rest -= dt;
          if (this.rest <= 0) this.liftOff(sea);
        } else {
          this.restCool -= dt;
          const onScreen = this.x > 0.15 && this.x < sea.A - 0.15 && this.y > 0.15 && this.y < 0.85;
          if (this.restCool <= 0 && onScreen && !sea.attentive && this.rng() < dt * 0.25) {
            this.rest = 5 + this.rng() * 4;
            sea.puff(this.x, this.y, 0.6, this.R);
          }
        }
      }
      if (!sc && this.lane === null) {
        this.targetAge += dt;
        const far = this.x < -0.8 || this.x > sea.A + 0.8 || this.y < -0.8 || this.y > 1.8;
        const arrived = Math.hypot(this.tx - this.x, this.ty - this.y) < 0.1;
        if (!resting && (arrived || far || this.targetAge > 16)) this.retarget(sea);
      }
    }
    liftOff(sea) {
      this.rest = 0;
      this.restCool = 16 + this.rng() * 12;
      this.boost = 1.7;
      sea.puff(this.x, this.y, 1, this.R);
      this.retarget(sea);
    }
    /** Paint into a scratch canvas sized for the stage, K offscreen px per world unit. */
    paint(ctx, K) {
      const { def, shape, L, pal, P } = this;
      const ch = Math.cos(this.heading);
      const sh = Math.sin(this.heading);
      const bh = def.bodyHalf;
      const amp = def.amp * this.ampK;
      const ph = this.phase;
      const flap = def.mode === "flap";
      const bend = clamp(this.turn * 0.45, -0.5, 0.5);
      const bank = this.bank;
      const X = this.x;
      const Y = this.y;
      const tilt = flap ? (_x, e) => amp * Math.sin(ph - e * def.lag) : (x, e) => amp * Math.sin(TAU * def.lag * x + ph) * Math.min(1, e / 0.12);
      const map = (x, y) => {
        const s = y < 0 ? -1 : 1;
        let ay = Math.abs(y);
        let xx = x;
        if (ay > bh) {
          const e = ay - bh;
          const c = Math.cos(tilt(x, e));
          ay = bh + e * c;
          if (flap) xx -= e * 0.1 * (1 - c);
        }
        ay *= 1 - bank * s * 0.16;
        const yy = s * ay;
        const a = bend * xx;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const bx = xx * ca - yy * sa;
        const by = xx * sa + yy * ca;
        P[0] = (X + (bx * ch - by * sh) * L) * K;
        P[1] = (Y + (bx * sh + by * ch) * L) * K;
        return P;
      };
      const body = new Path2D();
      for (let i = 0; i < shape.lx.length; i++) {
        const p = map(shape.lx[i], shape.ly[i]);
        if (i) body.lineTo(p[0], p[1]);
        else body.moveTo(p[0], p[1]);
      }
      body.closePath();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = pal.base;
      ctx.fill(body);
      ctx.globalCompositeOperation = "source-atop";
      for (const m of this.marks) {
        const p = map(m.x, m.y);
        ctx.globalAlpha = m.a;
        ctx.fillStyle = pal[m.c];
        ctx.beginPath();
        ctx.arc(p[0], p[1], m.r * L * K, 0, TAU);
        ctx.fill();
      }
      for (const s of [1, -1]) {
        if (!shape.wx.length) break;
        const wing = new Path2D();
        for (let i = 0; i < shape.wx.length; i++) {
          const p = map(shape.wx[i], shape.wy[i] * s);
          if (i) wing.lineTo(p[0], p[1]);
          else wing.moveTo(p[0], p[1]);
        }
        wing.closePath();
        let g;
        if (flap) {
          const [ax, ay] = map(0, s * bh);
          const [bx, by] = map(0, s * shape.span);
          g = ctx.createLinearGradient(ax, ay, bx, by);
          for (let k = 0; k <= 6; k++) g.addColorStop(k / 6, shade(Math.sin(tilt(0, k / 6 * (shape.span - bh)))));
        } else {
          const [ax, ay] = map(0.5, s * shape.span * 0.6);
          const [bx, by] = map(-0.5, s * shape.span * 0.6);
          g = ctx.createLinearGradient(ax, ay, bx, by);
          for (let k = 0; k <= 10; k++) g.addColorStop(k / 10, shade(Math.sin(tilt(0.5 - k / 10, 0.2)) * 0.8));
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.fill(wing);
      }
      const spine = (x0, x1) => {
        ctx.beginPath();
        for (let k = 0; k <= 10; k++) {
          const p = map(x0 + (x1 - x0) * k / 10, 0);
          if (k) ctx.lineTo(p[0], p[1]);
          else ctx.moveTo(p[0], p[1]);
        }
        ctx.stroke();
      };
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = 0.14;
      ctx.strokeStyle = "#fff6e6";
      ctx.lineWidth = bh * L * K * 0.9;
      spine(0.34, 0.02);
      ctx.globalAlpha = 0.34;
      ctx.strokeStyle = pal.ridge;
      ctx.lineWidth = bh * L * K * 0.42;
      spine(0.36, -0.5);
      ctx.globalAlpha = 0.24;
      ctx.strokeStyle = "#05060a";
      ctx.lineWidth = bh * L * K * 0.55;
      ctx.stroke(body);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      const er = Math.max(0.6, 0.024 * L * K);
      for (const s of [1, -1]) {
        ctx.fillStyle = "#0a0c10";
        let p = map(def.eyes[0], def.eyes[1] * s);
        ctx.beginPath();
        ctx.arc(p[0], p[1], er, 0, TAU);
        ctx.fill();
        ctx.fillStyle = pal.ridge;
        p = map(def.eyes[0] - 0.08, def.eyes[1] * s * 1.05);
        ctx.beginPath();
        ctx.arc(p[0], p[1], er * 0.8, 0, TAU);
        ctx.fill();
      }
      if (def.tusk) {
        ctx.strokeStyle = pal.tusk;
        ctx.lineWidth = Math.max(0.8, 0.035 * L * K);
        ctx.beginPath();
        let p = map(0.47, -0.04);
        ctx.moveTo(p[0], p[1]);
        p = map(0.5 + def.tusk, -0.06);
        ctx.lineTo(p[0], p[1]);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "destination-over";
      const qx = this.qx;
      const qy = this.qy;
      const tx = new Float32Array(TAIL_N + 1);
      const ty = new Float32Array(TAIL_N + 1);
      for (let i = 0; i <= TAIL_N; i++) {
        const a = Math.max(0, i - 1);
        const b = Math.min(TAIL_N, i + 1);
        const dx = qx[b] - qx[a];
        const dy = qy[b] - qy[a];
        const d = Math.hypot(dx, dy) || 1;
        const u = i / TAIL_N;
        const off = Math.sin(ph * 0.55 - i * 0.45) * L * 0.03 * Math.pow(u, 1.4);
        tx[i] = (qx[i] - dy / d * off) * K;
        ty[i] = (qy[i] + dx / d * off) * K;
      }
      const w0 = def.tailW * L * K;
      ctx.strokeStyle = pal.tail;
      ctx.globalAlpha = 1;
      for (let i = 0; i < TAIL_N; i++) {
        ctx.lineWidth = Math.max(0.5, w0 * Math.pow(1 - i / TAIL_N, 0.9));
        ctx.beginPath();
        ctx.moveTo(tx[i], ty[i]);
        ctx.lineTo(tx[i + 1], ty[i + 1]);
        ctx.stroke();
      }
      if (def.ribbon && pal.ribbon) {
        ctx.strokeStyle = pal.ribbon;
        ctx.globalAlpha = 0.9;
        for (let i = Math.round(TAIL_N * 0.42); i < TAIL_N - 1; i++) {
          ctx.lineWidth = Math.max(0.6, w0 * 1.7 * Math.pow(1 - i / TAIL_N, 0.6));
          ctx.beginPath();
          ctx.moveTo(tx[i], ty[i]);
          ctx.lineTo(tx[i + 1], ty[i + 1]);
          ctx.stroke();
        }
      }
      if (def.barb) {
        const i = Math.round(def.barb * TAIL_N);
        const dx = tx[i + 1] - tx[i];
        const dy = ty[i + 1] - ty[i];
        const d = Math.hypot(dx, dy) || 1;
        const len = L * K * 0.11;
        ctx.strokeStyle = pal.ridge;
        ctx.globalAlpha = 1;
        ctx.lineWidth = Math.max(0.5, w0 * 0.45);
        ctx.beginPath();
        ctx.moveTo(tx[i], ty[i]);
        ctx.lineTo(tx[i] + (dx * 0.94 - dy * 0.34) / d * len, ty[i] + (dy * 0.94 + dx * 0.34) / d * len);
        ctx.stroke();
      }
      if (def.paddle) {
        const n = TAIL_N;
        const a = Math.atan2(ty[n] - ty[n - 2], tx[n] - tx[n - 2]);
        ctx.fillStyle = pal.tail;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.ellipse(tx[n - 1], ty[n - 1], L * K * 0.075, L * K * 0.038, a, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  };
  var Sea = class {
    constructor(front, back, style) {
      __publicField(this, "style");
      __publicField(this, "look");
      __publicField(this, "rays", []);
      __publicField(this, "schools", []);
      __publicField(this, "pointer", null);
      /** Prompt card centre as fractions of the canvas (measured by React); `fc` is the same in world units. */
      __publicField(this, "focusF", { x: 0.5, y: 0.52 });
      /** Half-size of the centre block (greeting → chips): half-width as a fraction of the canvas width, half-height
       *  of its height. Rays orbit outside it and are never pushed into it. */
      __publicField(this, "boxF", { w: 0.23, h: 0.17 });
      __publicField(this, "orbitAngle", 0);
      __publicField(this, "laneScale", 1);
      __publicField(this, "laneKick", 0);
      /** Stage width in world units (height is 1). */
      __publicField(this, "A", 1.6);
      __publicField(this, "front");
      __publicField(this, "fctx");
      __publicField(this, "back");
      __publicField(this, "bctx");
      __publicField(this, "acc");
      __publicField(this, "actx");
      __publicField(this, "scratch");
      __publicField(this, "sctx");
      __publicField(this, "cols", 64);
      __publicField(this, "rows", 64);
      __publicField(this, "K", 64 * SS);
      __publicField(this, "W", 64 * SS);
      __publicField(this, "devW", 1);
      __publicField(this, "devH", 1);
      __publicField(this, "edgesX", new Float32Array(65));
      __publicField(this, "edgesY", new Float32Array(65));
      __publicField(this, "ripples", []);
      __publicField(this, "snow", []);
      __publicField(this, "colorCache", /* @__PURE__ */ new Map());
      __publicField(this, "raf", 0);
      __publicField(this, "last", 0);
      __publicField(this, "time", 0);
      __publicField(this, "attentionUntil", -1);
      __publicField(this, "lastPointerRipple", null);
      __publicField(this, "rng", mulberry32(2611));
      __publicField(this, "paused", false);
      __publicField(this, "dirty", true);
      __publicField(this, "cast", false);
      __publicField(this, "slow");
      this.style = style;
      this.look = LOOK[style];
      this.front = front;
      this.fctx = front.getContext("2d");
      this.back = back;
      this.bctx = back?.getContext("2d") ?? null;
      this.acc = document.createElement("canvas");
      this.actx = this.acc.getContext("2d", { willReadFrequently: true });
      this.scratch = document.createElement("canvas");
      this.sctx = this.scratch.getContext("2d");
      this.slow = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    get attentive() {
      return this.time < this.attentionUntil;
    }
    get fc() {
      return { x: this.focusF.x * this.A, y: this.focusF.y };
    }
    /** Is there room to keep the middle clear? (Not on a phone, where the card spans the width.) */
    get roomy() {
      return this.A > 0.8;
    }
    /** Lane radii round the prompt: the inner lane clears the centre block, outer ones run partly off the sides. */
    laneRadii(lane, seed) {
      const half = this.A / 2;
      const bw = this.boxF.w * this.A;
      const bh = this.boxF.h;
      const rxIn = this.roomy ? bw * 1.22 + 0.09 : clamp(half - 0.1, 0.12, 0.4);
      const ryIn = this.roomy ? bh * 1.22 + 0.09 : 0.3;
      const rxOut = Math.max(rxIn + 0.1, half + 0.04);
      const ryOut = Math.max(ryIn + 0.12, 0.44);
      const k = this.laneScale * (1 + 0.04 * Math.sin(this.time * 0.23 + seed));
      return [(rxIn + (rxOut - rxIn) * lane) * k, (ryIn + (ryOut - ryIn) * lane) * k];
    }
    /** Rounded-rectangle distance from the centre block grown by r: < 1 inside. Returns [q, dx, dy]. */
    boxQ(x, y, r) {
      const { x: cx, y: cy } = this.fc;
      const kx = this.boxF.w * this.A + r + 0.025;
      const ky = this.boxF.h + r + 0.025;
      const dx = x - cx;
      const dy = y - cy;
      return [Math.pow((dx / kx) ** 4 + (dy / ky) ** 4, 0.25), dx / kx, dy / ky];
    }
    /** Steering push off the centre block for an orbiting ray (zero when clear of it). */
    keepOut(x, y, r) {
      if (!this.roomy) return [0, 0];
      const [q, nx, ny] = this.boxQ(x, y, r);
      if (q >= 1.25) return [0, 0];
      const gx = nx ** 3;
      const gy = ny ** 3;
      const g = Math.hypot(gx, gy) || 1;
      const w = (1.25 - q) / 1.25 * 5;
      return [gx / g * w, gy / g * w];
    }
    /** Where an orbiting ray should head (a point a little ahead on its lane) and the pace that holds its slot. */
    orbitGoal(x, y, lane, slot, seed) {
      const { x: cx, y: cy } = this.fc;
      const [rx, ry] = this.laneRadii(lane, seed);
      const th = Math.atan2((y - cy) / ry, (x - cx) / rx);
      const behind = wrapAngle(slot + this.orbitAngle - th) * ORBIT_DIR;
      const ga = th + ORBIT_DIR * 0.32;
      const v = ORBIT_W * Math.hypot(rx * Math.sin(th), ry * Math.cos(th));
      return { gx: cx + Math.cos(ga) * rx, gy: cy + Math.sin(ga) * ry, speed: v * clamp(1 + behind * 1.6, 0.45, 1.9) * this.look.pace };
    }
    /** Hand out slots round the ring in proportion to each ray's size (body plus most of its tail), and start
     *  everyone in place, already swimming along their lane. */
    assignOrbits() {
      const ents = [];
      const seen = /* @__PURE__ */ new Set();
      const spot = (lane, a) => {
        const { x: cx, y: cy } = this.fc;
        const [rx, ry] = this.laneRadii(lane, 0);
        return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, Math.atan2(ry * Math.cos(a) * ORBIT_DIR, -rx * Math.sin(a) * ORBIT_DIR)];
      };
      for (const r of this.rays) {
        const sc = r.school;
        if (sc) {
          if (seen.has(sc) || sc.lane === null) continue;
          seen.add(sc);
          const members = this.rays.filter((m) => m.school === sc);
          ents.push({
            D: members[0].L * 6.5,
            put: (a) => {
              sc.slotAngle = a;
              sc.place(...spot(sc.lane, a));
              for (const m of members) m.placeInSchool();
            }
          });
        } else if (r.lane !== null) {
          const lane = r.lane;
          ents.push({
            D: 2 * r.R + r.def.tailLen * r.L * 0.6,
            put: (a) => {
              r.slotAngle = a;
              r.place(...spot(lane, a));
            }
          });
        }
      }
      const total = ents.reduce((sum, e) => sum + e.D, 0);
      let acc = 0;
      for (const e of ents) {
        e.put(-ORBIT_DIR * TAU * (acc + e.D / 2) / total);
        acc += e.D;
      }
    }
    /** The hard floor under the steering: no two bodies ever overlap, and orbiting rays never sit on the centre
     *  block. Bigger rays give way less. */
    separate() {
      const rs = this.rays;
      if (this.roomy) {
        const { x: cx, y: cy } = this.fc;
        for (const r of rs) {
          if (r.lane === null && !(r.school && r.school.lane !== null)) continue;
          const [q] = this.boxQ(r.x, r.y, r.R);
          if (q >= 1 || q < 1e-4) continue;
          const k = 1 + (1 / q - 1) * 0.35;
          r.x = cx + (r.x - cx) * k;
          r.y = cy + (r.y - cy) * k;
        }
      }
      for (let i = 0; i < rs.length; i++) {
        const a = rs[i];
        for (let j = i + 1; j < rs.length; j++) {
          const b = rs[j];
          const mates = a.school !== null && a.school === b.school;
          const min = (a.R + b.R) * (mates ? 0.8 : 1.02) + 0.012;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy);
          if (d >= min) continue;
          const ux = d > 1e-6 ? dx / d : 1;
          const uy = d > 1e-6 ? dy / d : 0;
          const over = (min - d) * 0.5;
          const wa = b.R / (a.R + b.R);
          const wb = 1 - wa;
          a.x -= ux * over * wa;
          a.y -= uy * over * wa;
          b.x += ux * over * wb;
          b.y += uy * over * wb;
        }
      }
    }
    /** Cast the rays once the stage's shape is known. */
    populate() {
      this.cast = true;
      const A = this.A;
      const specs = CAST[this.style];
      const schoolIds = [...new Set(specs.filter((s) => s.school !== void 0).map((s) => s.school))];
      const schools = /* @__PURE__ */ new Map();
      for (const id of schoolIds) {
        const lead = specs.find((s) => s.school === id);
        const sc = new School(lead.x * A, lead.y, SPECIES.mobula.speed * this.look.pace * 0.8, this.rng);
        sc.lane = lead.lane ?? null;
        sc.retarget(this);
        schools.set(id, sc);
        this.schools.push(sc);
      }
      const slotCount = /* @__PURE__ */ new Map();
      for (const s of specs) {
        const sc = s.school !== void 0 ? schools.get(s.school) : null;
        const k = s.school !== void 0 ? slotCount.get(s.school) ?? 0 : 0;
        if (s.school !== void 0) slotCount.set(s.school, k + 1);
        this.rays.push(new Ray(s, A, this.look, this.rng, sc, k));
      }
      for (const r of this.rays) if (!r.school && r.lane === null) r.retarget(this);
      this.assignOrbits();
      const n = Math.round(this.look.snow_n * A);
      for (let i = 0; i < n; i++) this.snow.push({ x: this.rng() * A, y: this.rng(), vy: 4e-3 + this.rng() * 8e-3, seed: this.rng() * 100 });
      for (let i = 0; i < 90; i++) this.step(1 / 60);
    }
    resize(cssW, cssH, dpr) {
      if (cssW < 2 || cssH < 2) return;
      this.devW = Math.max(1, Math.round(cssW * dpr));
      this.devH = Math.max(1, Math.round(cssH * dpr));
      for (const c of [this.front, this.back]) {
        if (!c) continue;
        c.width = this.devW;
        c.height = this.devH;
      }
      this.rows = clamp(Math.round(cssH / this.look.cell), 24, 120);
      this.cols = Math.max(1, Math.round(cssW / cssH * this.rows));
      this.A = cssW / cssH;
      this.K = this.rows * SS;
      this.W = this.cols * SS;
      this.acc.width = this.scratch.width = this.W;
      this.acc.height = this.scratch.height = this.K;
      this.edgesX = new Float32Array(this.cols + 1);
      this.edgesY = new Float32Array(this.rows + 1);
      for (let i = 0; i <= this.cols; i++) this.edgesX[i] = Math.round(i * this.devW / this.cols);
      for (let i = 0; i <= this.rows; i++) this.edgesY[i] = Math.round(i * this.devH / this.rows);
      if (!this.cast) this.populate();
      for (const f of this.snow) if (f.x > this.A + 0.05) f.x = this.rng() * this.A;
      this.dirty = true;
      if (this.raf) this.frame();
    }
    start() {
      if (this.raf) return;
      const loop = (now) => {
        const dt = this.last ? Math.min(0.05, (now - this.last) / 1e3) : 1 / 60;
        this.last = now;
        if (!this.paused && this.cast) this.step(dt * (this.slow ? 0.5 : 1));
        if (!this.paused || this.dirty) this.frame();
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
    stop() {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.last = 0;
    }
    setPaused(p) {
      this.paused = p;
      this.dirty = true;
    }
    // ── interaction (all positions are fractions of the canvas) ─────
    setPointer(fx, fy) {
      const x = fx * this.A;
      const y = fy;
      this.pointer = { x, y };
      const lp = this.lastPointerRipple;
      if (!lp || Math.hypot(x - lp.x, y - lp.y) > 0.1) {
        this.lastPointerRipple = { x, y };
        if (lp && !this.paused) this.ripple(x, y, 0.3, 1, 0.15);
      }
    }
    clearPointer() {
      this.pointer = null;
      this.lastPointerRipple = null;
    }
    /** Centre of the prompt block and its half-size, all as fractions of the canvas. */
    setFocus(fx, fy, hw, hh) {
      this.focusF = { x: fx, y: fy };
      if (hw !== void 0 && hh !== void 0) this.boxF = { w: hw, h: hh };
    }
    /** While someone types, the rays glide in to circle the prompt. */
    nudge() {
      const was = this.attentive;
      this.attentionUntil = this.time + 2.4;
      if (!was) {
        for (const r of this.rays) if (!r.school && r.lane === null) r.retarget(this);
      }
      for (const s of this.schools) {
        if (s.lane !== null) continue;
        s.tx = this.fc.x + (this.rng() - 0.5) * 0.5;
        s.ty = this.fc.y - 0.3;
      }
    }
    /** A prompt was saved: a ring breaks from the card and everything bolts outward. */
    scatter() {
      const { x: px, y: py } = this.fc;
      this.ripple(px, py, 1.3, 2.6, 0.38);
      this.ripple(px, py, 0.8, 2.6, 0.24);
      this.attentionUntil = -1;
      this.laneKick = 1;
      for (const r of this.rays) {
        if (r.rest > 0) r.liftOff(this);
        if (r.lane !== null || r.school && r.school.lane !== null) {
          r.boost = 2 - r.depth * 0.8;
          continue;
        }
        if (r.school) continue;
        const a = Math.atan2(r.y - py, r.x - px);
        r.tx = px + Math.cos(a) * 1.2 * Math.max(1, this.A);
        r.ty = py + Math.sin(a) * 1.2;
        r.targetAge = 0;
        r.boost = 2.6 - r.depth * 1.2;
      }
      for (const s of this.schools) {
        if (s.lane !== null) {
          s.boost = 2;
          continue;
        }
        const a = Math.atan2(s.y - py, s.x - px);
        s.tx = px + Math.cos(a) * 1.3 * Math.max(1, this.A);
        s.ty = py + Math.sin(a) * 1.3;
        s.boost = 2.4;
      }
    }
    /** A puff of sand where a ray settles or lifts off. */
    puff(x, y, strength, size) {
      this.ripple(x, y, strength, 1.6, 0.08 + size * 0.5);
    }
    ripple(x, y, strength, life, speed) {
      this.ripples.push({ x, y, born: this.time, life, speed, strength });
      if (this.ripples.length > 14) this.ripples.shift();
    }
    // ── simulation ─────────────────────────────────────────────────
    step(dt) {
      this.time += dt;
      const t = this.time;
      const att = this.attentive;
      this.orbitAngle += ORBIT_DIR * ORBIT_W * dt * (att ? 1.35 : 1) * this.look.pace;
      this.laneKick *= Math.exp(-dt / 1.3);
      this.laneScale += ((att ? 0.88 : 1) + this.laneKick * 0.9 - this.laneScale) * Math.min(1, dt * 1.4);
      for (const s of this.schools) s.update(dt, t, this);
      for (const r of this.rays) r.update(dt, t, this);
      this.separate();
      this.ripples = this.ripples.filter((r) => t - r.born < r.life);
      for (const f of this.snow) {
        f.y += f.vy * dt;
        f.x += Math.sin(t * 0.3 + f.seed) * 3e-3 * dt;
        if (f.y > 1.02) {
          f.y = -0.02;
          f.x = this.rng() * this.A;
        }
      }
    }
    // ── rendering ──────────────────────────────────────────────────
    rgba(r, g, b, a) {
      const ab = Math.round(clamp(a, 0, 1) * 20);
      const key = r >> 2 << 18 | g >> 2 << 12 | b >> 2 << 6 | ab;
      let s = this.colorCache.get(key);
      if (!s) {
        s = `rgba(${r >> 2 << 2},${g >> 2 << 2},${b >> 2 << 2},${ab / 20})`;
        if (this.colorCache.size > 6e3) this.colorCache.clear();
        this.colorCache.set(key, s);
      }
      return s;
    }
    frame() {
      this.dirty = false;
      if (!this.cast) return;
      const deep = this.look.backDepth;
      if (this.bctx) {
        this.layer(
          this.bctx,
          this.rays.filter((r) => r.depth >= deep),
          false
        );
      }
      this.layer(
        this.fctx,
        this.rays.filter((r) => r.depth < deep || !this.bctx),
        true
      );
    }
    layer(ctx, rays, top) {
      const { actx, sctx, K, W, cols, rows, edgesX, edgesY } = this;
      const look = this.look;
      const app = this.style === "app";
      const t = this.time;
      ctx.clearRect(0, 0, this.devW, this.devH);
      const cell = this.devH / rows;
      if (top && look.grid) {
        ctx.strokeStyle = look.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i < cols; i++) {
          ctx.moveTo(edgesX[i] + 0.5, 0);
          ctx.lineTo(edgesX[i] + 0.5, this.devH);
        }
        for (let i = 1; i < rows; i++) {
          ctx.moveTo(0, edgesY[i] + 0.5);
          ctx.lineTo(this.devW, edgesY[i] + 0.5);
        }
        ctx.stroke();
      }
      ctx.font = `500 ${Math.max(6, Math.round(cell * 0.72))}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const gap = Math.max(1, Math.round(cell * 0.07));
      if (top) {
        for (const f of this.snow) {
          const gx = Math.floor(f.x * rows);
          const gy = Math.floor(f.y * rows);
          if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
          const flick = 0.45 + 0.55 * Math.sin(t * 1.7 + f.seed * 3);
          ctx.fillStyle = this.rgba(...look.snow, (app ? 0.34 : 0.4) * flick);
          ctx.fillText(SNOW[Math.floor(f.seed) % SNOW.length], (edgesX[gx] + edgesX[gx + 1]) / 2, (edgesY[gy] + edgesY[gy + 1]) / 2);
        }
      }
      if (!rays.length && !(top && this.ripples.length)) return;
      actx.clearRect(0, 0, W, K);
      const order = [...rays].sort((a, b) => b.depth - a.depth);
      for (const r of order) {
        sctx.clearRect(0, 0, W, K);
        r.paint(sctx, K);
        actx.globalAlpha = 1 - r.depth * 0.3;
        actx.drawImage(this.scratch, 0, 0);
      }
      actx.globalAlpha = 1;
      const px = actx.getImageData(0, 0, W, K).data;
      const tick = t / 0.22;
      for (let gy = 0; gy < rows; gy++) {
        const y = edgesY[gy];
        const h = edgesY[gy + 1] - y;
        for (let gx = 0; gx < cols; gx++) {
          let sa = 0;
          let sr = 0;
          let sg = 0;
          let sb = 0;
          for (let oy = 0; oy < SS; oy++) {
            let p = ((gy * SS + oy) * W + gx * SS) * 4;
            for (let ox = 0; ox < SS; ox++, p += 4) {
              const a = px[p + 3];
              if (!a) continue;
              sa += a;
              sr += px[p] * a;
              sg += px[p + 1] * a;
              sb += px[p + 2] * a;
            }
          }
          const cov = sa / (255 * SS * SS);
          const x = edgesX[gx];
          const w = edgesX[gx + 1] - x;
          const cx = x + w / 2;
          const cy = y + h / 2;
          if (cov < 0.04) {
            if (top && this.ripples.length) {
              const wx = (gx + 0.5) / rows;
              const wy = (gy + 0.5) / rows;
              let rip = 0;
              for (const r2 of this.ripples) {
                const age = t - r2.born;
                const band = 0.018 + age * 0.012;
                const d = Math.abs(Math.hypot(wx - r2.x, wy - r2.y) - age * r2.speed);
                if (d < band) rip += (1 - d / band) * (1 - age / r2.life) * r2.strength;
              }
              if (rip > 0.12) {
                ctx.fillStyle = this.rgba(...look.ripple, Math.min(0.8, rip * 0.75));
                ctx.fillText(PUFF[Math.min(3, Math.floor(rip * 3))], cx, cy);
              }
            }
            continue;
          }
          const r = sr / sa;
          const g = sg / sa;
          const b = sb / sa;
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          const jit = hash(gx, gy, Math.floor(tick + hash(gy, gx, 7) * 3));
          if (!app) {
            const lift = (v) => v + (255 - v) * 0.16;
            if (cov >= 0.42) {
              const level = clamp(Math.floor(Math.pow(1 - lum, 0.75) * FULL.length + (jit - 0.5) * 4), 0, FULL.length - 1);
              ctx.fillStyle = this.rgba(lift(r), lift(g), lift(b), 0.5 + 0.35 * cov);
              ctx.fillText(FULL[level], cx, cy);
            } else if (cov >= 0.16) {
              ctx.fillStyle = this.rgba(lift(r), lift(g), lift(b), 0.35 + cov);
              ctx.fillText(MID[Math.floor(jit * MID.length)], cx, cy);
            } else {
              ctx.fillStyle = this.rgba(lift(r), lift(g), lift(b), 0.3 + cov * 2);
              ctx.fillText(EDGE[Math.floor(jit * EDGE.length)], cx, cy);
            }
            continue;
          }
          if (cov >= 0.42) {
            const a = 0.62 + 0.38 * clamp((cov - 0.42) / 0.4, 0, 1);
            ctx.fillStyle = this.rgba(r, g, b, a);
            ctx.fillRect(x + gap, y + gap, w - gap * 2, h - gap * 2);
            const level = clamp(Math.floor(Math.pow(1 - lum, 0.7) * FULL.length + (jit - 0.5) * 4), 0, FULL.length - 1);
            if (jit > 0.982) ctx.fillStyle = ACCENTS[Math.floor(jit * 1e3) % ACCENTS.length];
            else if (lum < 0.55) ctx.fillStyle = this.rgba(r + (255 - r) * 0.72, g + (255 - g) * 0.72, b + (255 - b) * 0.72, a);
            else ctx.fillStyle = this.rgba(r * 0.28, g * 0.28, b * 0.3, a);
            ctx.fillText(FULL[level], cx, cy);
          } else if (cov >= 0.16) {
            ctx.fillStyle = this.rgba(r, g, b, cov * 0.55);
            ctx.fillRect(x + gap, y + gap, w - gap * 2, h - gap * 2);
            ctx.fillStyle = this.rgba(r + (255 - r) * 0.45, g + (255 - g) * 0.45, b + (255 - b) * 0.42, 0.55 + cov);
            ctx.fillText(MID[Math.floor(jit * MID.length)], cx, cy);
          } else {
            ctx.fillStyle = this.rgba(r + (255 - r) * 0.5, g + (255 - g) * 0.5, b + (255 - b) * 0.45, 0.35 + cov * 2.5);
            ctx.fillText(EDGE[Math.floor(jit * EDGE.length)], cx, cy);
          }
        }
      }
    }
  };
  return __toCommonJS(engine_exports);
})();
