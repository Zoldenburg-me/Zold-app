/* The narwhal sea behind Home: Scrolltide's Mobula engine (vendor/mobula-sea.js, a built bundle;
 * its sources are not in the repo), drawn on two fixed canvases under the page. If the script fails
 * to load or cannot run, Home simply has no sea. Only Home has it; any other view stops it. Reduced
 * motion paints one still frame. */

// Vendor paths keep the long default cache (routes/pages.ts): bump v whenever the engine file changes.
const SRC = "/business/vendor/mobula-sea.js?v=1";
const calm = matchMedia("(prefers-reduced-motion: reduce)");
let sea = null, loading = null, on = false, broken = false;

function load() {
  loading ??= new Promise((ok) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.onload = () => ok(window.Mobula?.Sea ? window.Mobula : null);
    s.onerror = () => ok(null);
    document.head.append(s);
  });
  return loading;
}

function canvas(id) {
  const c = document.createElement("canvas");
  c.id = id;
  c.className = "zb-sea";
  c.setAttribute("aria-hidden", "true");
  document.body.prepend(c);
  return c;
}

/** Keep the narwhals out of the block they would swim across: the command section while it is there. */
function focus() {
  if (!sea || !on) return;
  const q = document.querySelector(".zb-h-cmd")?.getBoundingClientRect();
  if (q && q.width > 1) sea.setFocus((q.left + q.right) / 2 / innerWidth, (q.top + q.bottom) / 2 / innerHeight, q.width / 2 / innerWidth, q.height / 2 / innerHeight);
  if (calm.matches) sea.frame();
}

/** resize() reallocates both canvases, so only when the window changes, never per scroll. */
function fit() {
  if (!sea || !on) return;
  sea.resize(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, 2));
  focus();
}

const swim = () => { if (!calm.matches && !document.hidden) sea.start(); };

function wire() {
  addEventListener("resize", fit);
  // The canvases are fixed and the page scrolls: the command section's place on screen moves with it.
  addEventListener("scroll", focus, { passive: true });
  addEventListener("pointermove", (e) => on && sea.setPointer(e.clientX / innerWidth, e.clientY / innerHeight));
  document.documentElement.addEventListener("pointerleave", () => on && sea.clearPointer());
  document.addEventListener("input", (e) => on && e.target.id === "hm-q" && sea.nudge());
  document.addEventListener("visibilitychange", () => on && (document.hidden ? sea.stop() : swim()));
}

/** Called after every render: the sea swims on Home and nowhere else. */
export async function seaFor(view) {
  on = view === "overview";
  document.documentElement.classList.toggle("has-sea", on && !!sea);
  if (!on) { sea?.stop(); return; }
  const M = await load();
  if (!M || !on || broken) return;
  try {
    if (!sea) {
      // canvas() prepends, so the blurred far layer made last sits underneath the near one.
      const near = canvas("sea"), far = canvas("sea-far");
      try { sea = new M.Sea(near, far, "app"); } catch (e) { near.remove(); far.remove(); throw e; }
      wire();
    }
    document.documentElement.classList.add("has-sea");
    fit();
    swim();
  } catch {
    // An engine that cannot run here (no 2D canvas, a different API) is the same as no engine.
    broken = true;
    sea?.stop();
    document.documentElement.classList.remove("has-sea");
  }
}
