// The signing pad's geometry on /invoice/<token>, apart from the page so a test can import it.

/** Points to a path that curves through the midpoints, as a pen would. */
export const strokePath = (pts) => (pts.length < 3
  ? `M${pts[0]} L${pts[pts.length - 1]}`
  : `M${pts[0]} ${pts.slice(1, -1).map((p, i) => `Q${p} ${(p[0] + pts[i + 2][0]) / 2},${(p[1] + pts[i + 2][1]) / 2}`).join(" ")} L${pts[pts.length - 1]}`);
