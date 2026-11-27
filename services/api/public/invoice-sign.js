// Signing on /invoice/<token>: who may sign and the pad's geometry, apart from the page so a test can import them.

// Signing is the recipient's own mark on their copy: it needs no Pay link,
// only an unpaid invoice and a reader who is not its issuer.
export const canSign = (inv, own) => !own && inv.state !== "PAID" && inv.state !== "RECONCILED";

/** Points to a path that curves through the midpoints, as a pen would. */
export const strokePath = (pts) => (pts.length < 3
  ? `M${pts[0]} L${pts[pts.length - 1]}`
  : `M${pts[0]} ${pts.slice(1, -1).map((p, i) => `Q${p} ${(p[0] + pts[i + 2][0]) / 2},${(p[1] + pts[i + 2][1]) / 2}`).join(" ")} L${pts[pts.length - 1]}`);
