/**
 * A minimal QR encoder, so a payment page can show a scannable code.
 *
 * Written rather than installed: the repo has four runtime dependencies and a
 * payment page is not a reason to add a fifth, particularly one that would
 * also need vendoring into the browser bundle. Rendering server-side as SVG
 * means one implementation and nothing new on the client.
 *
 * SCOPE, deliberately narrow — byte mode, error-correction level L, versions
 * 1 to 6 (up to 134 bytes). It stops short of version 7, which is where the
 * format gains an 18-bit version-information block: more spec surface for no
 * gain here, because the only thing this encodes is a 42-character address
 * (version 3, less than half the budget).
 *
 * A full EIP-681 URI with an amount runs to ~135 bytes and therefore does NOT
 * fit — measured, not guessed. That is fine, because the URI is a link on the
 * page rather than the QR payload (see pay.ts for why), but anything passing a
 * URI here gets a loud throw rather than a code that will not scan.
 *
 * VERIFICATION: `npm run pay:test` reads the finished matrix back through the
 * same module ordering and reconstructs the payload, which proves the
 * bitstream, padding, masking and placement agree with each other. It does NOT
 * prove the module ordering matches the spec — only an independent decoder or
 * a phone can do that. Check one before this is put in front of users.
 */

/** Byte-mode capacity at EC level L, indexed by version. */
const CAPACITY_L = [0, 17, 32, 53, 78, 106, 134] as const;
/** Data codewords per block, and EC codewords per block, at level L. */
const BLOCKS_L = [0, 1, 1, 1, 1, 1, 2] as const;
const DATA_PER_BLOCK_L = [0, 19, 34, 55, 80, 108, 68] as const;
const EC_PER_BLOCK_L = [0, 7, 10, 15, 20, 26, 18] as const;
/** Alignment-pattern centre coordinates by version (v1 has none). */
const ALIGN_CENTRES: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

// --- GF(256), primitive polynomial 0x11d -----------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` EC codewords. */
function generator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i];
      next[i + 1] ^= mul(poly[i], EXP[d]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon remainder — the EC codewords for one block. */
function ecCodewords(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = generator(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

function pickVersion(byteLength: number): number {
  for (let v = 1; v <= 6; v++) if (byteLength <= CAPACITY_L[v]) return v;
  throw new Error(
    `${byteLength} bytes is too long for a version-6 QR at level L (max ${CAPACITY_L[6]}). ` +
      `This encoder is sized for addresses; a full EIP-681 URI does not fit and belongs in a link.`,
  );
}

/** Mode indicator + length + payload + terminator + pad, as codewords. */
function bitstream(bytes: Uint8Array, version: number): Uint8Array {
  const dataCodewords = DATA_PER_BLOCK_L[version] * BLOCKS_L[version];
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // 8-bit character count for versions 1-9
  for (const b of bytes) push(b, 8);
  // Terminator, then pad to a whole codeword.
  for (let i = 0; i < 4 && bits.length < dataCodewords * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(dataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j];
    out[i] = byte;
  }
  // Alternating pad bytes for the remainder, as the spec prescribes.
  for (let i = bits.length / 8, alt = 0; i < dataCodewords; i++, alt++) {
    out[i] = alt % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

/** Interleave data blocks then EC blocks — the order they go on the grid. */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const blocks = BLOCKS_L[version];
  const perBlock = DATA_PER_BLOCK_L[version];
  const ecLen = EC_PER_BLOCK_L[version];
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  for (let b = 0; b < blocks; b++) {
    const slice = data.subarray(b * perBlock, (b + 1) * perBlock);
    dataBlocks.push(slice);
    ecBlocks.push(ecCodewords(slice, ecLen));
  }
  const out: number[] = [];
  for (let i = 0; i < perBlock; i++) for (const b of dataBlocks) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);
  return new Uint8Array(out);
}

type Grid = Int8Array[]; // -1 = free, 0 = light, 1 = dark

function blankGrid(size: number): Grid {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

function placeFinder(g: Grid, row: number, col: number) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= g.length || cc >= g.length) continue;
      const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark =
        inRing && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      g[rr][cc] = dark ? 1 : 0;
    }
  }
}

/** Everything that is not payload: finders, separators, timing, alignment,
 *  the dark module, and the reserved format areas. */
function placeFunctionPatterns(g: Grid, version: number) {
  const size = g.length;
  placeFinder(g, 0, 0);
  placeFinder(g, 0, size - 7);
  placeFinder(g, size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    g[6][i] = bit;
    g[i][6] = bit;
  }

  for (const r of ALIGN_CENTRES[version]) {
    for (const c of ALIGN_CENTRES[version]) {
      // Skip the three that would sit on a finder.
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          g[r + dr][c + dc] = dark ? 1 : 0;
        }
      }
    }
  }

  g[size - 8][8] = 1; // dark module

  // Reserve the format-information areas as 0 so they are not free for data.
  for (let i = 0; i <= 8; i++) {
    if (g[8][i] === -1) g[8][i] = 0;
    if (g[i][8] === -1) g[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (g[8][size - 1 - i] === -1) g[8][size - 1 - i] = 0;
    if (g[size - 1 - i][8] === -1) g[size - 1 - i][8] = 0;
  }
}

/**
 * The order payload modules are written in: two-module columns from the right,
 * alternating upward and downward, skipping the timing column.
 *
 * Exported because the test reads the matrix back through this same order. See
 * the caveat at the top of the file about what that does and does not prove.
 */
export function dataModuleOrder(version: number): Array<[number, number]> {
  const size = version * 4 + 17;
  const reserved = blankGrid(size);
  placeFunctionPatterns(reserved, version);
  const order: Array<[number, number]> = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    const col = right === 6 ? right - 1 : right; // column 6 is timing
    const left = col - 1;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, left]) {
        if (c === 6) continue;
        if (reserved[row][c] === -1) order.push([row, c]);
      }
    }
    upward = !upward;
    if (right === 6) break;
  }
  return order;
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The four penalty rules. Any mask decodes correctly — the format bits record
 *  which was used — so this is about scan robustness, not validity. */
function penalty(g: Grid): number {
  const n = g.length;
  let score = 0;
  const dark = (r: number, c: number) => g[r][c] === 1;

  // Rule 1: runs of five or more of the same colour.
  for (let i = 0; i < n; i++) {
    for (const line of [
      Array.from({ length: n }, (_, j) => dark(i, j)),
      Array.from({ length: n }, (_, j) => dark(j, i)),
    ]) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        if (line[j] === line[j - 1]) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = dark(r, c);
      if (v === dark(r, c + 1) && v === dark(r + 1, c) && v === dark(r + 1, c + 1)) score += 3;
    }
  }
  // Rule 3: the 1:1:3:1:1 finder-like pattern with four light modules either side.
  const finder = [true, false, true, true, true, false, true];
  const matches = (line: boolean[], at: number) => {
    for (let i = 0; i < 7; i++) if (line[at + i] !== finder[i]) return false;
    const before = line.slice(Math.max(0, at - 4), at);
    const after = line.slice(at + 7, at + 11);
    return (
      (before.length === 4 && before.every((v) => !v)) || (after.length === 4 && after.every((v) => !v))
    );
  };
  for (let i = 0; i < n; i++) {
    const row = Array.from({ length: n }, (_, j) => dark(i, j));
    const colLine = Array.from({ length: n }, (_, j) => dark(j, i));
    for (let at = 0; at + 7 <= n; at++) {
      if (matches(row, at)) score += 40;
      if (matches(colLine, at)) score += 40;
    }
  }
  // Rule 4: deviation from an even split of dark and light.
  let darkCount = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) darkCount++;
  const pct = (darkCount * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/** 15-bit format information: EC level L (01) + mask, BCH(15,5) + XOR mask. */
function formatBits(mask: number): number {
  let value = (0b01 << 3) | mask;
  let rem = value << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0b10100110111 << i;
  }
  return ((value << 10) | rem) ^ 0b101010000010010;
}

/**
 * Write both copies of the 15 format bits.
 *
 * Bit i goes to one position in the vertical strip (column 8, running down the
 * left) and one in the horizontal strip (row 8, running in from the right).
 * Getting this wrong is invisible to a round-trip through our own reader and
 * fatal to a real scanner, which is exactly what happened: the first version
 * transposed the two strips and reversed the bit order along row 8, so the data
 * was perfect and no decoder could tell which mask had been applied. It also
 * walked over the dark module at [size-8][8]; the vertical run below starts at
 * size-7 and leaves it alone.
 */
function placeFormat(g: Grid, mask: number) {
  const size = g.length;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const v = ((bits >> i) & 1) as 0 | 1;
    // Vertical strip, column 8: rows 0-5, then 7-8, then the bottom seven.
    if (i < 6) g[i][8] = v;
    else if (i < 8) g[i + 1][8] = v;
    else g[size - 15 + i][8] = v;
    // Horizontal strip, row 8: the rightmost eight, then column 7, then 5-0.
    if (i < 8) g[8][size - 1 - i] = v;
    else if (i === 8) g[8][7] = v;
    else g[8][14 - i] = v;
  }
  g[size - 8][8] = 1; // the dark module, restated after the strips are written
}

/**
 * Encode `text` and return the module matrix, `true` meaning a dark module.
 *
 * The quiet zone is not included — a renderer must leave four modules of
 * margin, or scanners will struggle regardless of how correct the code is.
 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const size = version * 4 + 17;
  const codewords = interleave(bitstream(bytes, version), version);

  const grid = blankGrid(size);
  placeFunctionPatterns(grid, version);
  const order = dataModuleOrder(version);
  order.forEach(([r, c], i) => {
    const byte = codewords[i >> 3];
    const bit = byte === undefined ? 0 : (byte >> (7 - (i & 7))) & 1;
    grid[r][c] = bit as 0 | 1;
  });

  // Try every mask on a copy and keep the calmest-looking one.
  let best: { score: number; grid: Grid; mask: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = grid.map((row) => Int8Array.from(row));
    for (const [r, c] of order) {
      if (MASKS[mask](r, c)) candidate[r][c] = candidate[r][c] === 1 ? 0 : 1;
    }
    placeFormat(candidate, mask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, grid: candidate, mask };
  }
  return best!.grid.map((row) => Array.from(row, (v) => v === 1));
}

/**
 * Render as a self-contained SVG, including the four-module quiet zone.
 *
 * One `<path>` rather than a rect per module: a version-6 code is 41x41, and
 * ~1,700 elements is a lot of markup to send for a square of dots.
 */
export function qrSvg(text: string, opts: { size?: number } = {}): string {
  const matrix = qrMatrix(text);
  const modules = matrix.length;
  const quiet = 4;
  const span = modules + quiet * 2;
  const px = opts.size ?? 256;
  let path = "";
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (matrix[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="Payment QR code">` +
    `<rect width="${span}" height="${span}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/>` +
    `</svg>`
  );
}
