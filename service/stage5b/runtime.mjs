// service/stage5b/entry.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ../amath-bot-lab/src/data/tokens.ts
var TOKENS = {
  "0": { face: "0", count: 5, type: "lightNumber", point: 1 },
  "1": { face: "1", count: 6, type: "lightNumber", point: 1 },
  "2": { face: "2", count: 6, type: "lightNumber", point: 1 },
  "3": { face: "3", count: 5, type: "lightNumber", point: 1 },
  "4": { face: "4", count: 5, type: "lightNumber", point: 2 },
  "5": { face: "5", count: 4, type: "lightNumber", point: 2 },
  "6": { face: "6", count: 4, type: "lightNumber", point: 2 },
  "7": { face: "7", count: 4, type: "lightNumber", point: 2 },
  "8": { face: "8", count: 4, type: "lightNumber", point: 2 },
  "9": { face: "9", count: 4, type: "lightNumber", point: 2 },
  "10": { face: "10", count: 2, type: "heavyNumber", point: 3 },
  "11": { face: "11", count: 1, type: "heavyNumber", point: 4 },
  "12": { face: "12", count: 2, type: "heavyNumber", point: 3 },
  "13": { face: "13", count: 1, type: "heavyNumber", point: 6 },
  "14": { face: "14", count: 1, type: "heavyNumber", point: 4 },
  "15": { face: "15", count: 1, type: "heavyNumber", point: 4 },
  "16": { face: "16", count: 1, type: "heavyNumber", point: 4 },
  "17": { face: "17", count: 1, type: "heavyNumber", point: 6 },
  "18": { face: "18", count: 1, type: "heavyNumber", point: 4 },
  "19": { face: "19", count: 1, type: "heavyNumber", point: 7 },
  "20": { face: "20", count: 1, type: "heavyNumber", point: 5 },
  "+": { face: "+", count: 4, type: "operator", point: 2 },
  "-": { face: "-", count: 4, type: "operator", point: 2 },
  x: { face: "\xD7", count: 4, type: "operator", point: 2 },
  "/": { face: "\xF7", count: 4, type: "operator", point: 2 },
  "+/-": { face: "+/-", count: 5, type: "choice", point: 1 },
  "x//": { face: "x/\xF7", count: 4, type: "choice", point: 1 },
  "=": { face: "=", count: 11, type: "equals", point: 1 },
  "?": { face: "?", count: 4, type: "blank", point: 0 }
};
var TOKEN_KINDS = Object.keys(TOKENS);
var TOTAL_TILES = 100;
var PLUS_MINUS_FACES = ["+", "-"];
var TIMES_DIVIDE_FACES = ["\xD7", "\xF7"];
var BLANK_FACES = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "+",
  "-",
  "\xD7",
  "\xF7",
  "="
];
function needsAssignment(kind) {
  const type = TOKENS[kind].type;
  return type === "choice" || type === "blank";
}
function assignmentOptions(kind) {
  if (kind === "+/-") return PLUS_MINUS_FACES;
  if (kind === "x//") return TIMES_DIVIDE_FACES;
  if (kind === "?") return BLANK_FACES;
  return [];
}

// ../amath-bot-lab/src/core/tiles.ts
function createManifest() {
  const tiles = [];
  for (const kind of TOKEN_KINDS) {
    for (let copy = 0; copy < TOKENS[kind].count; copy += 1) {
      tiles.push({ id: `${kind}#${copy}`, kind });
    }
  }
  const kindOf = new Map(tiles.map((tile) => [tile.id, tile.kind]));
  return { tiles, kindOf };
}
function tileKind(manifest, id) {
  const kind = manifest.kindOf.get(id);
  if (kind === void 0) throw new Error(`unknown tile id: ${id}`);
  return kind;
}
function kindCounts(manifest, ids) {
  const counts = /* @__PURE__ */ new Map();
  for (const id of ids) {
    const kind = tileKind(manifest, id);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

// ../amath-bot-lab/src/core/rng.ts
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ../amath-bot-lab/src/bots/rng.ts
var SEAT_SALT = { A: 2654435761, B: 2246822507 };
function decisionSeed(gameSeed, side, ply) {
  let hash = (gameSeed ^ SEAT_SALT[side]) >>> 0;
  hash = Math.imul(hash ^ ply + 668265263, 374761393) >>> 0;
  hash = (hash ^ hash >>> 13) >>> 0;
  return Math.imul(hash, 2654435761) >>> 0;
}
function decisionRandom(gameSeed, side, ply) {
  return mulberry32(decisionSeed(gameSeed, side, ply));
}

// ../amath-bot-lab/src/core/rules.ts
var EQLAB_COMPAT_RULES = {
  id: "eqlab-compat",
  label: "EQ-Lab compat (\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A conformance test)",
  boardSize: 15,
  rackSize: 8,
  bingoBonus: 40,
  exchangeMinPoolReserve: 5,
  noScoreStreakLength: 6,
  divisionByZero: "adjacent-token",
  // The preset the whole learning stack is pinned to, so it follows the
  // canonical turn exactly. Before this the lab refilled a turn late, which §18
  // recorded as a turn-mechanics divergence and which left the model looking at
  // short racks and standing piles it was never trained on.
  refill: "in-turn",
  rackOut: {
    requireEmptyPool: false,
    countPoolPoints: true,
    maxRemainingTiles: 8,
    bonusMultiplier: 2
  },
  unresolved: []
};

// ../amath-bot-lab/src/env/config.ts
var BOT_RULES = EQLAB_COMPAT_RULES;
function exchangeReserve(bagCount, opponentRackCount, rules = BOT_RULES) {
  return bagCount + opponentRackCount - rules.rackSize;
}
function isExchangeAllowed(bagCount, opponentRackCount, rules = BOT_RULES) {
  return exchangeReserve(bagCount, opponentRackCount, rules) >= rules.exchangeMinPoolReserve;
}

// ../amath-bot-lab/src/core/move.ts
function canonicalizeMove(move) {
  switch (move.type) {
    case "pass":
      return "pass";
    case "exchange": {
      const kinds = [...move.kinds].sort();
      return `exchange:${kinds.join(",")}`;
    }
    case "place": {
      const parts = [...move.placements].sort((a, b) => a.cell - b.cell).map((p) => `${p.cell}:${p.kind}:${p.face}`);
      return `place:${parts.join("|")}`;
    }
  }
}
function moveId(move) {
  const text = canonicalizeMove(move);
  let h0 = 8997;
  let h1 = 33826;
  let h2 = 40164;
  let h3 = 52210;
  for (let i = 0; i < text.length; i += 1) {
    h0 ^= text.charCodeAt(i) & 65535;
    let carry = h0 * 435;
    const n0 = carry & 65535;
    carry = h1 * 435 + Math.floor(carry / 65536);
    const n1 = carry & 65535;
    carry = h2 * 435 + h0 * 256 + Math.floor(carry / 65536);
    const n2 = carry & 65535;
    carry = h3 * 435 + h1 * 256 + Math.floor(carry / 65536);
    h3 = carry & 65535;
    h2 = n2;
    h1 = n1;
    h0 = n0;
  }
  return hex4(h3) + hex4(h2) + hex4(h1) + hex4(h0);
}
function hex4(limb) {
  return limb.toString(16).padStart(4, "0");
}

// ../amath-bot-lab/src/data/boardLayout.ts
var ROWS = [
  [
    "ex3",
    "px1",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "ex3",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px1",
    "ex3"
  ],
  [
    "px1",
    "ex2",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "ex2",
    "px1"
  ],
  [
    "px1",
    "px1",
    "ex2",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "ex2",
    "px1",
    "px1"
  ],
  [
    "px2",
    "px1",
    "px1",
    "ex2",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "ex2",
    "px1",
    "px1",
    "px2"
  ],
  [
    "px1",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px1"
  ],
  [
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1"
  ],
  [
    "px1",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px1"
  ],
  [
    "ex3",
    "px1",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "px3star",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px1",
    "ex3"
  ],
  [
    "px1",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px1"
  ],
  [
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1"
  ],
  [
    "px1",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px1"
  ],
  [
    "px2",
    "px1",
    "px1",
    "ex2",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "ex2",
    "px1",
    "px1",
    "px2"
  ],
  [
    "px1",
    "px1",
    "ex2",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "ex2",
    "px1",
    "px1"
  ],
  [
    "px1",
    "ex2",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "px3",
    "px1",
    "px1",
    "px1",
    "ex2",
    "px1"
  ],
  [
    "ex3",
    "px1",
    "px1",
    "px2",
    "px1",
    "px1",
    "px1",
    "ex3",
    "px1",
    "px1",
    "px1",
    "px2",
    "px1",
    "px1",
    "ex3"
  ]
];
var BOARD_SIZE = 15;
var CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
var CENTER_INDEX = Math.floor(BOARD_SIZE / 2) * BOARD_SIZE + Math.floor(BOARD_SIZE / 2);
var SLOTS = ROWS.flat();

// ../amath-bot-lab/src/core/board.ts
var EMPTY_BOARD = Object.freeze(Array.from({ length: CELL_COUNT }, () => null));
function rowOf(cell) {
  return Math.floor(cell / BOARD_SIZE);
}
function colOf(cell) {
  return cell % BOARD_SIZE;
}
function cellAt(row, col) {
  return row * BOARD_SIZE + col;
}
function slotAt(cell) {
  return SLOTS[cell] ?? "px1";
}
function isBoardEmpty(board) {
  return board.every((cell) => cell === null);
}
function withCells(board, writes) {
  const next = board.slice();
  for (const [cell, value2] of writes) next[cell] = value2;
  return next;
}

// ../amath-bot-lab/src/core/diagnostics.ts
function diagnostic(code, message, extra = {}) {
  return {
    code,
    severity: "error",
    cells: extra.cells ?? [],
    message,
    ...extra.runText === void 0 ? {} : { runText: extra.runText },
    ...extra.values === void 0 ? {} : { values: extra.values }
  };
}

// ../amath-bot-lab/src/core/rational.ts
var LIMIT = 67108863;
var LIMIT_BIG = 67108863n;
var MAX_SAFE_BIG = 9007199254740991n;
var INTERN_LIMIT = 4096;
var INTERNED = Array.from({ length: INTERN_LIMIT * 2 + 1 }, (_, index) => ({
  n: index - INTERN_LIMIT,
  d: 1,
  big: null
}));
var ZERO = INTERNED[INTERN_LIMIT];
function whole(n) {
  if (n >= -INTERN_LIMIT && n <= INTERN_LIMIT) return INTERNED[n + INTERN_LIMIT];
  if (n >= -LIMIT && n <= LIMIT) return { n, d: 1, big: null };
  return { n: 0, d: 0, big: { n: BigInt(n), d: 1n } };
}
function gcdSmall(a, b) {
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}
function gcdBig(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}
function small(n, d) {
  if (n === 0) return ZERO;
  if (d === 1) return whole(n);
  const g = gcdSmall(n < 0 ? -n : n, d);
  const rn = n / g;
  const rd = d / g;
  if (rd === 1) return whole(rn);
  if (rn >= -LIMIT && rn <= LIMIT && rd <= LIMIT) return { n: rn, d: rd, big: null };
  return { n: 0, d: 0, big: { n: BigInt(rn), d: BigInt(rd) } };
}
function fromPair(n, d) {
  if (n >= -LIMIT_BIG && n <= LIMIT_BIG && d <= LIMIT_BIG) {
    const small_ = Number(n);
    return d === 1n ? whole(small_) : { n: small_, d: Number(d), big: null };
  }
  return { n: 0, d: 0, big: { n, d } };
}
function bigOf(n, d) {
  if (n === 0n) return ZERO;
  const sign = d < 0n ? -1n : 1n;
  const nn = n * sign;
  const dd = d * sign;
  const g = gcdBig(nn, dd) || 1n;
  return fromPair(nn / g, dd / g);
}
function pairOf(a) {
  return a.big ?? { n: BigInt(a.n), d: BigInt(a.d) };
}
function fromInt(value2) {
  if (typeof value2 === "number") return whole(value2);
  if (value2 >= -LIMIT_BIG && value2 <= LIMIT_BIG) return whole(Number(value2));
  return { n: 0, d: 0, big: { n: value2, d: 1n } };
}
function add(a, b) {
  if (a.big === null && b.big === null) {
    if (a.d === 1 && b.d === 1) return whole(a.n + b.n);
    return small(a.n * b.d + b.n * a.d, a.d * b.d);
  }
  const x = pairOf(a);
  const y = pairOf(b);
  return bigOf(x.n * y.d + y.n * x.d, x.d * y.d);
}
function sub(a, b) {
  if (a.big === null && b.big === null) {
    if (a.d === 1 && b.d === 1) return whole(a.n - b.n);
    return small(a.n * b.d - b.n * a.d, a.d * b.d);
  }
  const x = pairOf(a);
  const y = pairOf(b);
  return bigOf(x.n * y.d - y.n * x.d, x.d * y.d);
}
function mul(a, b) {
  if (a.big === null && b.big === null) return small(a.n * b.n, a.d * b.d);
  const x = pairOf(a);
  const y = pairOf(b);
  return bigOf(x.n * y.n, x.d * y.d);
}
function div(a, b) {
  if (isZero(b)) return null;
  if (a.big === null && b.big === null) {
    const n = a.n * b.d;
    const d = a.d * b.n;
    return d < 0 ? small(-n, -d) : small(n, d);
  }
  const x = pairOf(a);
  const y = pairOf(b);
  return bigOf(x.n * y.d, x.d * y.n);
}
function neg(a) {
  if (a.big === null) {
    if (a.n === 0) return ZERO;
    return a.d === 1 ? whole(-a.n) : { n: -a.n, d: a.d, big: null };
  }
  return { n: 0, d: 0, big: { n: -a.big.n, d: a.big.d } };
}
function isZero(a) {
  return a.big === null && a.n === 0;
}
function equals(a, b) {
  if (a.big === null) return b.big === null && a.n === b.n && a.d === b.d;
  return b.big !== null && a.big.n === b.big.n && a.big.d === b.big.d;
}
var NOT_WHOLE = -1;
function wholeNonNegative(a) {
  if (a.big === null) return a.d === 1 && a.n >= 0 ? a.n : NOT_WHOLE;
  const big = a.big;
  if (big.d !== 1n || big.n < 0n) return NOT_WHOLE;
  return big.n > MAX_SAFE_BIG ? Number.POSITIVE_INFINITY : Number(big.n);
}
function formatShort(a) {
  if (a.big === null) return a.d === 1 ? String(a.n) : `${a.n}/${a.d}`;
  return `${a.big.n}/${a.big.d}`;
}

// ../amath-bot-lab/src/core/expression.ts
var UNITS = /* @__PURE__ */ new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
var TENS = /* @__PURE__ */ new Set(["10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20"]);
var MARKS = /* @__PURE__ */ new Set(["=", "+", "-", "*", "/"]);
function toMark(face) {
  if (face === "\xD7") return "*";
  if (face === "\xF7") return "/";
  return face;
}
function runText(tokens) {
  return tokens.map((t) => t.face).join(" ");
}
function faceCategory(face) {
  const mark = toMark(face);
  if (UNITS.has(mark)) return "unit";
  if (TENS.has(mark)) return "tens";
  return "mark";
}
var ADJACENT_MESSAGE = {
  ADJACENT_OPERATORS: "\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E2B\u0E21\u0E32\u0E22\u0E15\u0E34\u0E14\u0E01\u0E31\u0E19\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49",
  TENS_TOUCHING: "\u0E40\u0E1A\u0E35\u0E49\u0E22 10-20 \u0E2B\u0E49\u0E32\u0E21\u0E15\u0E34\u0E14\u0E01\u0E31\u0E1A\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E2D\u0E37\u0E48\u0E19",
  DIV_BY_ZERO: "\u0E2B\u0E32\u0E23\u0E14\u0E49\u0E27\u0E22 0 \u0E44\u0E21\u0E48\u0E44\u0E14\u0E49"
};
function adjacentFacesProblem(leftFace, rightFace, rules) {
  const a = toMark(leftFace);
  const b = toMark(rightFace);
  if (MARKS.has(a) && MARKS.has(b) && !(a === "=" && b === "-")) return "ADJACENT_OPERATORS";
  if (TENS.has(a) && TENS.has(b) || TENS.has(a) && UNITS.has(b) || UNITS.has(a) && TENS.has(b)) {
    return "TENS_TOUCHING";
  }
  if (rules.divisionByZero === "adjacent-token" && a === "/" && b === "0") return "DIV_BY_ZERO";
  return null;
}
var MAX_DIGITS = 3;
function evaluateSide(faces) {
  const parsed = parseSide(faces.map((face, index) => ({ face, cell: index })));
  if (!parsed.ok) return null;
  const value2 = evaluate(parsed.node);
  return value2.ok ? value2.value : null;
}
function isEqualsFace(face) {
  return toMark(face) === "=";
}
function isMarkFace(face) {
  return MARKS.has(toMark(face));
}
function analyzeRun(tokens, rules) {
  const seq = tokens.map((t) => toMark(t.face));
  const cells = tokens.map((t) => t.cell);
  const text = runText(tokens);
  const problems = [];
  const note = (code, message, at, values2) => {
    problems.push(
      diagnostic(code, message, {
        cells: at,
        runText: text,
        ...values2 === void 0 ? {} : { values: values2 }
      })
    );
  };
  const first = seq[0];
  const last = seq[seq.length - 1];
  if (!seq.includes("=")) {
    note("MISSING_EQUALS", `${text}: \u0E44\u0E21\u0E48\u0E21\u0E35\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E2B\u0E21\u0E32\u0E22 =`, cells);
  }
  if (first !== void 0 && MARKS.has(first) && first !== "-") {
    note("LEADING_OPERATOR", `${text}: \u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19\u0E14\u0E49\u0E27\u0E22\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E2B\u0E21\u0E32\u0E22\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49`, [cells[0]]);
  }
  if (last !== void 0 && MARKS.has(last)) {
    note("TRAILING_OPERATOR", `${text}: \u0E25\u0E07\u0E17\u0E49\u0E32\u0E22\u0E14\u0E49\u0E27\u0E22\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E2B\u0E21\u0E32\u0E22\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49`, [cells[cells.length - 1]]);
  }
  for (let i = 0; i < seq.length - 1; i += 1) {
    const a = seq[i];
    const b = seq[i + 1];
    const pair = [cells[i], cells[i + 1]];
    const adjacency = adjacentFacesProblem(tokens[i].face, tokens[i + 1].face, rules);
    if (adjacency !== null) note(adjacency, `${text}: ${ADJACENT_MESSAGE[adjacency]}`, pair);
    if (a === "-" && b === "0" && (i === 0 || seq[i - 1] === "=")) {
      note("NEGATIVE_ZERO", `${text}: 0 \u0E15\u0E34\u0E14\u0E25\u0E1A\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49`, pair);
    }
  }
  let runStart = -1;
  for (let i = 0; i <= seq.length; i += 1) {
    const token = seq[i];
    if (token !== void 0 && UNITS.has(token)) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const length = i - runStart;
      if (length > MAX_DIGITS) {
        note("MAX_3_DIGITS", `${text}: \u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E40\u0E01\u0E34\u0E19 3 \u0E2B\u0E25\u0E31\u0E01\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49`, cells.slice(runStart, i));
      }
      runStart = -1;
    }
  }
  let bufferStart = -1;
  for (let i = 0; i <= seq.length; i += 1) {
    const token = seq[i];
    const isNumber = token !== void 0 && !MARKS.has(token);
    if (isNumber) {
      if (bufferStart < 0) bufferStart = i;
      continue;
    }
    if (bufferStart >= 0) {
      const digits = seq.slice(bufferStart, i).join("");
      if (digits.length >= 2 && digits.startsWith("0")) {
        note("LEADING_ZERO", `${text}: \u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19\u0E14\u0E49\u0E27\u0E22 0 \u0E44\u0E21\u0E48\u0E44\u0E14\u0E49`, cells.slice(bufferStart, i));
      }
      bufferStart = -1;
    }
  }
  if (problems.length > 0) return { diagnostics: problems, sideValues: null };
  const sides = [[]];
  tokens.forEach((token) => {
    if (toMark(token.face) === "=") sides.push([]);
    else sides[sides.length - 1].push(token);
  });
  const values = [];
  for (const side of sides) {
    const parsed = parseSide(side);
    if (!parsed.ok) {
      note(
        "MALFORMED_EXPRESSION",
        `${text}: \u0E04\u0E33\u0E19\u0E27\u0E13\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49`,
        side.map((t) => t.cell)
      );
      return { diagnostics: problems, sideValues: null };
    }
    const evaluated = evaluate(parsed.node);
    if (!evaluated.ok) {
      note("DIV_BY_ZERO", `${text}: \u0E2B\u0E32\u0E23\u0E14\u0E49\u0E27\u0E22 0 \u0E44\u0E21\u0E48\u0E44\u0E14\u0E49`, evaluated.cells);
      return { diagnostics: problems, sideValues: null };
    }
    values.push(evaluated.value);
  }
  const head = values[0];
  if (!values.every((value2) => equals(value2, head))) {
    note(
      "UNBALANCED",
      `${text}: \u0E2A\u0E2D\u0E07\u0E02\u0E49\u0E32\u0E07\u0E44\u0E21\u0E48\u0E40\u0E17\u0E48\u0E32\u0E01\u0E31\u0E19 (${values.map(formatShort).join(" \u2260 ")})`,
      cells,
      values.map(formatShort)
    );
    return { diagnostics: problems, sideValues: values };
  }
  return { diagnostics: problems, sideValues: values };
}
function parseSide(tokens) {
  let index = 0;
  const peek = () => {
    const token = tokens[index];
    return token === void 0 ? void 0 : toMark(token.face);
  };
  const parseNumber = () => {
    const token = tokens[index];
    if (token === void 0) return null;
    const face = toMark(token.face);
    if (TENS.has(face)) {
      index += 1;
      return { type: "num", value: BigInt(face), cells: [token.cell] };
    }
    if (!UNITS.has(face)) return null;
    let digits = "";
    const cells = [];
    while (index < tokens.length) {
      const next = tokens[index];
      const nextFace = toMark(next.face);
      if (!UNITS.has(nextFace)) break;
      digits += nextFace;
      cells.push(next.cell);
      index += 1;
    }
    return { type: "num", value: BigInt(digits), cells };
  };
  const parseUnary = () => {
    if (peek() === "-") {
      const token = tokens[index];
      index += 1;
      const operand = parseUnary();
      if (operand === null) return null;
      return { type: "neg", operand, cells: [token.cell, ...operand.cells] };
    }
    return parseNumber();
  };
  const parseTerm = () => {
    let left = parseUnary();
    if (left === null) return null;
    for (; ; ) {
      const op = peek();
      if (op !== "*" && op !== "/") break;
      const opCell = tokens[index].cell;
      index += 1;
      const right = parseUnary();
      if (right === null) return null;
      left = { type: "bin", op, left, right, cells: [opCell] };
    }
    return left;
  };
  const parseExpr = () => {
    let left = parseTerm();
    if (left === null) return null;
    for (; ; ) {
      const op = peek();
      if (op !== "+" && op !== "-") break;
      const opCell = tokens[index].cell;
      index += 1;
      const right = parseTerm();
      if (right === null) return null;
      left = { type: "bin", op, left, right, cells: [opCell] };
    }
    return left;
  };
  const node = parseExpr();
  if (node === null || index !== tokens.length) return { ok: false };
  return { ok: true, node };
}
function evaluate(node) {
  if (node.type === "num") return { ok: true, value: fromInt(node.value) };
  if (node.type === "neg") {
    const inner = evaluate(node.operand);
    return inner.ok ? { ok: true, value: neg(inner.value) } : inner;
  }
  const left = evaluate(node.left);
  if (!left.ok) return left;
  const right = evaluate(node.right);
  if (!right.ok) return right;
  switch (node.op) {
    case "+":
      return { ok: true, value: add(left.value, right.value) };
    case "-":
      return { ok: true, value: sub(left.value, right.value) };
    case "*":
      return { ok: true, value: mul(left.value, right.value) };
    case "/": {
      const quotient = div(left.value, right.value);
      if (quotient === null) {
        return { ok: false, cells: collectCells(node.right) };
      }
      return { ok: true, value: quotient };
    }
  }
}
function collectCells(node) {
  if (node.type === "num") return [...node.cells];
  if (node.type === "neg") return [...node.cells];
  return [...collectCells(node.left), ...node.cells, ...collectCells(node.right)];
}

// ../amath-bot-lab/src/core/faceTable.ts
var NO_FACE = -1;
var CAT_UNIT = 0;
var CAT_TENS = 1;
var CAT_MARK = 2;
var MARK_NONE = 0;
var MARK_PLUS = 1;
var MARK_MINUS = 2;
var MARK_TIMES = 3;
var MARK_DIVIDE = 4;
var MARK_EQUALS = 5;
var ADJ_OK = 0;
var ADJ_PROBLEMS = [
  "ADJACENT_OPERATORS",
  "TENS_TOUCHING",
  "DIV_BY_ZERO"
];
var CACHE = /* @__PURE__ */ new WeakMap();
function faceTableFor(rules) {
  const cached = CACHE.get(rules);
  if (cached !== void 0) return cached;
  const built = build(rules);
  CACHE.set(rules, built);
  return built;
}
function build(rules) {
  const faces = [...BLANK_FACES];
  for (const kind of TOKEN_KINDS) {
    const face = TOKENS[kind].face;
    if (!faces.includes(face)) faces.push(face);
  }
  const count = faces.length;
  const index = new Map(faces.map((face, id) => [face, id]));
  const category = new Uint8Array(count);
  const mark = new Uint8Array(count);
  const equals2 = new Uint8Array(count);
  const isMarkArray = new Uint8Array(count);
  const digit = new Int8Array(count).fill(-1);
  const tens = new Int8Array(count).fill(-1);
  faces.forEach((face, id) => {
    const kindOfFace = faceCategory(face);
    category[id] = kindOfFace === "unit" ? CAT_UNIT : kindOfFace === "tens" ? CAT_TENS : CAT_MARK;
    equals2[id] = isEqualsFace(face) ? 1 : 0;
    isMarkArray[id] = isMarkFace(face) ? 1 : 0;
    if (kindOfFace === "unit") digit[id] = Number(face);
    if (kindOfFace === "tens") tens[id] = Number(face);
    mark[id] = markOf(face);
  });
  const numberFace = new Int16Array(21).fill(NO_FACE);
  for (let value2 = 0; value2 <= 20; value2 += 1) {
    numberFace[value2] = index.get(String(value2)) ?? NO_FACE;
  }
  const adjacent = new Uint8Array(count * count);
  for (let left = 0; left < count; left += 1) {
    for (let right = 0; right < count; right += 1) {
      const problem = adjacentFacesProblem(faces[left], faces[right], rules);
      adjacent[left * count + right] = problem === null ? ADJ_OK : ADJ_PROBLEMS.indexOf(problem) + 1;
    }
  }
  return {
    faces,
    count,
    category,
    mark,
    equals: equals2,
    isMark: isMarkArray,
    digit,
    tens,
    adjacent,
    numberFace,
    idOf: (face) => index.get(face) ?? NO_FACE,
    problemOf: (code) => ADJ_PROBLEMS[code - 1]
  };
}
function markOf(face) {
  switch (face) {
    case "+":
      return MARK_PLUS;
    case "-":
      return MARK_MINUS;
    case "\xD7":
    case "*":
      return MARK_TIMES;
    case "\xF7":
    case "/":
      return MARK_DIVIDE;
    case "=":
      return MARK_EQUALS;
    default:
      return MARK_NONE;
  }
}

// ../amath-bot-lab/src/space-map/geometry.ts
var OPPOSITE = {
  up: "down",
  down: "up",
  left: "right",
  right: "left"
};
var AXIS = {
  up: "vertical",
  down: "vertical",
  left: "horizontal",
  right: "horizontal"
};
var HEAD = { vertical: "up", horizontal: "left" };
var TAIL = { vertical: "down", horizontal: "right" };
function axisOf(direction) {
  return AXIS[direction];
}
function oppositeOf(direction) {
  return OPPOSITE[direction];
}
function perpendicularAxis(axis) {
  return axis === "vertical" ? "horizontal" : "vertical";
}
function backwardOf(axis) {
  return HEAD[axis];
}
function forwardOf(axis) {
  return TAIL[axis];
}
function stepFrom(cell, direction) {
  const row = rowOf(cell);
  const col = colOf(cell);
  switch (direction) {
    case "up":
      return row > 0 ? cell - BOARD_SIZE : -1;
    case "down":
      return row < BOARD_SIZE - 1 ? cell + BOARD_SIZE : -1;
    case "left":
      return col > 0 ? cell - 1 : -1;
    case "right":
      return col < BOARD_SIZE - 1 ? cell + 1 : -1;
  }
}

// ../amath-bot-lab/src/space-map/constraints.ts
var ALL_FACES = BLANK_FACES;
var ALL_KINDS = Object.freeze([...TOKEN_KINDS]);
var UNCONSTRAINED = Object.freeze({
  unconstrained: true,
  faces: ALL_FACES,
  kinds: ALL_KINDS
});
var NO_CONSTRAINT = Object.freeze({
  cross: null,
  line: null,
  allowed: UNCONSTRAINED,
  blocked: false
});
function kindsForFaces(faces) {
  if (faces.length === 0) return [];
  const wanted = new Set(faces);
  return TOKEN_KINDS.filter((kind) => {
    const options = needsAssignment(kind) ? assignmentOptions(kind) : [TOKENS[kind].face];
    return options.some((face) => wanted.has(face));
  });
}
var ConstraintTable = class {
  constructor(board, rules, crossFacesCache) {
    this.board = board;
    this.rules = rules;
    this.crossFacesCache = crossFacesCache;
  }
  board;
  rules;
  crossFacesCache;
  #cache = new Array(
    CELL_COUNT * 2
  );
  at(cell, travelAxis) {
    const slot2 = cell * 2 + (travelAxis === "vertical" ? 0 : 1);
    const cached = this.#cache[slot2];
    if (cached !== void 0) return cached;
    const computed = this.#compute(cell, travelAxis);
    this.#cache[slot2] = computed;
    return computed;
  }
  isBlocked(cell, travelAxis) {
    return this.at(cell, travelAxis).blocked;
  }
  #compute(cell, travelAxis) {
    if (this.board[cell]) return NO_CONSTRAINT;
    const cross = this.#crossRun(cell, perpendicularAxis(travelAxis));
    const line2 = this.#lineNeighbours(cell, travelAxis);
    if (cross === null && line2 === null) return NO_CONSTRAINT;
    const faces = cross === null ? line2.faces : line2 === null ? cross.faces : cross.faces.filter((face) => line2.faces.includes(face));
    return {
      cross,
      line: line2,
      allowed: { unconstrained: false, faces, kinds: kindsForFaces(faces) },
      blocked: faces.length === 0
    };
  }
  /**
   * The run perpendicular to travel, judged in full: once this cell is filled
   * that run is finished, so it must be a legal equation exactly as it stands.
   */
  #crossRun(cell, crossAxis) {
    const before = this.#occupiedSide(cell, backwardOf(crossAxis)).reverse();
    const after = this.#occupiedSide(cell, forwardOf(crossAxis));
    if (before.length === 0 && after.length === 0) return null;
    const faceOf = (at) => this.board[at].face;
    const prefix = before.map((at) => ({ face: faceOf(at), cell: at }));
    const suffix = after.map((at) => ({ face: faceOf(at), cell: at }));
    const cacheKey = this.crossFacesCache === void 0 ? null : JSON.stringify([
      this.rules.id,
      this.rules.divisionByZero,
      prefix.map((token) => token.face),
      suffix.map((token) => token.face)
    ]);
    let faces = cacheKey === null ? void 0 : this.crossFacesCache.get(cacheKey);
    if (faces === void 0) {
      faces = ALL_FACES.filter(
        (face) => analyzeRun([...prefix, { face, cell }, ...suffix], this.rules).diagnostics.length === 0
      );
      if (cacheKey !== null && this.crossFacesCache.size < 2e5) {
        this.crossFacesCache.set(cacheKey, faces);
      }
    }
    return {
      cells: [...before, ...after],
      text: [...prefix.map((t) => t.face), "_", ...suffix.map((t) => t.face)].join(" "),
      faces
    };
  }
  /**
   * The tiles already touching this cell along the line being built. The line
   * is unfinished, so only the rules a pair of neighbours settles on its own
   * are applied — see the note at the top of the file.
   */
  #lineNeighbours(cell, travelAxis) {
    const before = this.#occupiedSide(cell, backwardOf(travelAxis)).reverse();
    const after = this.#occupiedSide(cell, forwardOf(travelAxis));
    if (before.length === 0 && after.length === 0) return null;
    const faceOf = (at) => this.board[at].face;
    const left = before.length > 0 ? faceOf(before[before.length - 1]) : null;
    const right = after.length > 0 ? faceOf(after[0]) : null;
    const digitsLeft = trailingDigits(before.map(faceOf));
    const digitsRight = trailingDigits([...after.map(faceOf)].reverse());
    const faces = ALL_FACES.filter((face) => {
      if (left !== null && adjacentFacesProblem(left, face, this.rules) !== null) return false;
      if (right !== null && adjacentFacesProblem(face, right, this.rules) !== null) return false;
      if (faceCategory(face) === "unit" && digitsLeft + 1 + digitsRight > MAX_DIGITS) return false;
      return true;
    });
    return {
      cells: [...before, ...after],
      text: [...before.map(faceOf), "_", ...after.map(faceOf)].join(" "),
      faces
    };
  }
  /** Occupied cells running away from `cell` in `direction`, nearest first. */
  #occupiedSide(cell, direction) {
    const out = [];
    let at = stepFrom(cell, direction);
    while (at >= 0 && this.board[at]) {
      out.push(at);
      at = stepFrom(at, direction);
    }
    return out;
  }
};
function trailingDigits(faces) {
  let count = 0;
  for (let i = faces.length - 1; i >= 0; i -= 1) {
    if (faceCategory(faces[i]) !== "unit") break;
    count += 1;
  }
  return count;
}

// ../amath-bot-lab/src/space-map/types.ts
var DIRECTIONS = ["up", "down", "left", "right"];
var SPACE_MODES = ["cross", "extend", "hook", "seed"];

// ../amath-bot-lab/src/space-map/propagation.ts
var DIRECTION_INDEX = { up: 0, down: 1, left: 2, right: 3 };
var MODE_INDEX = { cross: 0, extend: 1, hook: 2, seed: 3 };
function directionIndex(direction) {
  return DIRECTION_INDEX[direction];
}
function maskBit(direction, mode) {
  return 1 << DIRECTION_INDEX[direction] * SPACE_MODES.length + MODE_INDEX[mode];
}
function directionBits(direction) {
  let bits = 0;
  for (const mode of SPACE_MODES) bits |= maskBit(direction, mode);
  return bits;
}
function findAnchors(board, constraints) {
  const anchors = [];
  if (isBoardEmpty(board)) {
    for (const direction of DIRECTIONS) {
      anchors.push({
        index: anchors.length,
        cell: CENTER_INDEX,
        direction,
        mode: "seed",
        axis: axisOf(direction),
        source: []
      });
    }
    return anchors;
  }
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (board[cell]) continue;
    for (const direction of DIRECTIONS) {
      const axis = axisOf(direction);
      if (constraints.isBlocked(cell, axis)) continue;
      const from = stepFrom(cell, oppositeOf(direction));
      if (from >= 0 && board[from]) {
        const behind = stepFrom(from, oppositeOf(direction));
        const collinear = behind >= 0 && Boolean(board[behind]);
        const mode = collinear ? "extend" : "cross";
        const source = runThrough(board, from, collinear ? axis : perpendicular(axis));
        anchors.push({ index: anchors.length, cell, direction, mode, axis, source });
        continue;
      }
      if (touchesAlong(board, cell, axis)) continue;
      const across = constraints.at(cell, axis).cross;
      if (across === null || across.cells.length === 0) continue;
      anchors.push({
        index: anchors.length,
        cell,
        direction,
        mode: "hook",
        axis,
        source: across.cells
      });
    }
  }
  return anchors;
}
function touchesAlong(board, cell, axis) {
  const back = stepFrom(cell, backwardOf(axis));
  if (back >= 0 && board[back]) return true;
  const ahead = stepFrom(cell, forwardOf(axis));
  return ahead >= 0 && Boolean(board[ahead]);
}
function perpendicular(axis) {
  return axis === "vertical" ? "horizontal" : "vertical";
}
function runThrough(board, cell, axis) {
  const cells = [cell];
  let at = stepFrom(cell, backwardOf(axis));
  while (at >= 0 && board[at]) {
    cells.unshift(at);
    at = stepFrom(at, backwardOf(axis));
  }
  at = stepFrom(cell, forwardOf(axis));
  while (at >= 0 && board[at]) {
    cells.push(at);
    at = stepFrom(at, forwardOf(axis));
  }
  return cells;
}
function propagate(board, constraints, anchors, options) {
  const openMask = new Uint16Array(CELL_COUNT);
  const minCost = new Uint8Array(CELL_COUNT * 4);
  const queue = [];
  const seen = /* @__PURE__ */ new Set();
  let truncated = false;
  const key = (anchorIndex, mode, direction, cell) => ((anchorIndex * SPACE_MODES.length + MODE_INDEX[mode]) * 4 + DIRECTION_INDEX[direction]) * CELL_COUNT + cell;
  const admit = (node) => {
    const id = key(node.anchor.index, node.mode, node.direction, node.cell);
    if (seen.has(id)) return false;
    if (queue.length >= options.maxStates) {
      truncated = true;
      return false;
    }
    seen.add(id);
    queue.push(node);
    openMask[node.cell] = (openMask[node.cell] ?? 0) | maskBit(node.direction, node.mode);
    const slot2 = node.cell * 4 + DIRECTION_INDEX[node.direction];
    const previous = minCost[slot2];
    if (previous === 0 || node.cost < previous) minCost[slot2] = Math.min(node.cost, 255);
    return true;
  };
  for (const anchor of anchors) {
    admit({
      cell: anchor.cell,
      direction: anchor.direction,
      mode: anchor.mode,
      anchor,
      cost: 1,
      kind: "seed",
      through: EMPTY_CELLS,
      parent: null,
      probe: null
    });
  }
  for (let head = 0; head < queue.length; head += 1) {
    const state = queue[head];
    const budgetLeft = options.maxNewTiles - state.cost;
    const forwardOpen = countForwardOpen(board, constraints, state.cell, state.direction);
    let continued = false;
    if (budgetLeft > 0) {
      const ahead = advance(board, state.cell, state.direction);
      if (ahead !== null && !constraints.isBlocked(ahead.cell, axisOf(state.direction))) {
        admit({
          cell: ahead.cell,
          direction: state.direction,
          mode: state.mode,
          anchor: state.anchor,
          cost: state.cost + 1,
          kind: ahead.through.length > 0 ? "jump" : "forward",
          through: ahead.through,
          parent: state,
          probe: null
        });
        continued = true;
      }
    }
    state.probe = {
      cell: state.cell,
      direction: state.direction,
      forwardOpen,
      budgetLeft,
      continues: continued,
      reason: stopReason(board, constraints, state, forwardOpen, budgetLeft, continued)
    };
  }
  const statesByCell = Array.from({ length: CELL_COUNT }, () => []);
  for (const state of queue) statesByCell[state.cell].push(state);
  return { anchors, states: queue, statesByCell, openMask, minCost, truncated };
}
function stopReason(board, constraints, state, forwardOpen, budgetLeft, continues) {
  if (continues) {
    return `\u0E40\u0E14\u0E34\u0E19\u0E15\u0E23\u0E07\u0E15\u0E48\u0E2D\u0E44\u0E14\u0E49 \xB7 \u0E02\u0E49\u0E32\u0E07\u0E2B\u0E19\u0E49\u0E32\u0E22\u0E31\u0E07\u0E40\u0E1B\u0E34\u0E14\u0E2D\u0E35\u0E01 ${forwardOpen} \u0E0A\u0E48\u0E2D\u0E07 \xB7 \u0E40\u0E2B\u0E25\u0E37\u0E2D\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E2D\u0E35\u0E01 ${budgetLeft} \u0E15\u0E31\u0E27`;
  }
  if (budgetLeft <= 0) return `\u0E2B\u0E22\u0E38\u0E14\u0E40\u0E1E\u0E23\u0E32\u0E30\u0E43\u0E0A\u0E49\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E04\u0E23\u0E1A ${state.cost} \u0E15\u0E31\u0E27\u0E41\u0E25\u0E49\u0E27`;
  const next = stepFrom(state.cell, state.direction);
  if (next < 0) return "\u0E2B\u0E22\u0E38\u0E14\u0E40\u0E1E\u0E23\u0E32\u0E30\u0E0A\u0E19\u0E02\u0E2D\u0E1A\u0E01\u0E23\u0E30\u0E14\u0E32\u0E19";
  const ahead = advance(board, state.cell, state.direction);
  if (ahead === null) return "\u0E2B\u0E22\u0E38\u0E14\u0E40\u0E1E\u0E23\u0E32\u0E30\u0E40\u0E25\u0E22\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E40\u0E14\u0E34\u0E21\u0E44\u0E1B\u0E41\u0E25\u0E49\u0E27\u0E0A\u0E19\u0E02\u0E2D\u0E1A\u0E01\u0E23\u0E30\u0E14\u0E32\u0E19";
  if (constraints.isBlocked(ahead.cell, axisOf(state.direction))) {
    return "\u0E2B\u0E22\u0E38\u0E14\u0E40\u0E1E\u0E23\u0E32\u0E30\u0E0A\u0E48\u0E2D\u0E07\u0E16\u0E31\u0E14\u0E44\u0E1B\u0E15\u0E31\u0E19 \u2014 \u0E41\u0E19\u0E27\u0E15\u0E31\u0E14\u0E02\u0E2D\u0E07\u0E21\u0E31\u0E19\u0E44\u0E21\u0E48\u0E23\u0E31\u0E1A\u0E2B\u0E19\u0E49\u0E32\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E43\u0E14\u0E40\u0E25\u0E22";
  }
  return "\u0E2B\u0E22\u0E38\u0E14";
}
var EMPTY_CELLS = Object.freeze([]);
function advance(board, cell, direction) {
  let at = stepFrom(cell, direction);
  const through = [];
  while (at >= 0 && board[at]) {
    through.push(at);
    at = stepFrom(at, direction);
  }
  if (at < 0) return null;
  return { cell: at, through: through.length === 0 ? EMPTY_CELLS : through };
}
function countForwardOpen(board, constraints, cell, direction) {
  const axis = axisOf(direction);
  let count = 0;
  let at = stepFrom(cell, direction);
  while (at >= 0 && !board[at] && !constraints.isBlocked(at, axis)) {
    count += 1;
    at = stepFrom(at, direction);
  }
  return count;
}

// ../amath-bot-lab/src/space-map/spaceMap.ts
var Mask = class {
  #bits;
  constructor(bits) {
    this.#bits = bits;
  }
  has(direction) {
    return (this.#bits & directionBits(direction)) !== 0;
  }
  hasMode(direction, mode) {
    return (this.#bits & maskBit(direction, mode)) !== 0;
  }
  modesOf(direction) {
    return SPACE_MODES.filter((mode) => this.hasMode(direction, mode));
  }
  directions() {
    return DIRECTIONS.filter((direction) => this.has(direction));
  }
  entries() {
    return this.directions().map((direction) => ({
      direction,
      modes: this.modesOf(direction)
    }));
  }
  isEmpty() {
    return this.#bits === 0;
  }
  count() {
    return this.directions().length;
  }
};
var EMPTY_MASK = new Mask(0);
var SpaceMapImpl = class {
  id;
  boardVersion;
  #constraints;
  #propagation;
  #resolved;
  #maskCache = new Array(CELL_COUNT);
  #pathCache = /* @__PURE__ */ new Map();
  #candidateCache = /* @__PURE__ */ new Map();
  #anchorList;
  #cachedStats = null;
  constructor(input) {
    this.id = input.id;
    this.boardVersion = input.boardVersion;
    this.#constraints = input.constraints;
    this.#propagation = input.propagation;
    this.#resolved = input.params;
    this.#anchorList = input.propagation.anchors.map(toAnchor);
  }
  isReachable(cell) {
    return inRange(cell) && this.#propagation.openMask[cell] !== 0;
  }
  directionsAt(cell) {
    if (!inRange(cell)) return EMPTY_MASK;
    const cached = this.#maskCache[cell];
    if (cached !== void 0) return cached;
    const mask = new Mask(this.#propagation.openMask[cell]);
    this.#maskCache[cell] = mask;
    return mask;
  }
  constraintsAt(cell, direction) {
    const axis = axisOf(direction);
    const check = this.#constraints.at(cell, axis);
    const cost = inRange(cell) ? this.#propagation.minCost[cell * 4 + directionIndex(direction)] : 0;
    return {
      cell,
      direction,
      axis,
      blocked: check.blocked,
      cross: check.cross,
      line: check.line,
      allowed: check.allowed,
      minCost: cost === 0 ? null : cost
    };
  }
  anchors() {
    return this.#anchorList;
  }
  pathCountAt(cell) {
    if (!inRange(cell)) return 0;
    return this.#propagation.statesByCell[cell].length;
  }
  pathsTo(cell) {
    if (!inRange(cell)) return [];
    const cached = this.#pathCache.get(cell);
    if (cached !== void 0) return cached;
    const built = this.#propagation.statesByCell[cell].map(
      (state, index) => this.#materialise(state, index)
    );
    this.#pathCache.set(cell, built);
    return built;
  }
  reachableCells() {
    const out = [];
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      if (this.#propagation.openMask[cell] !== 0) out.push(cell);
    }
    return out;
  }
  /**
   * PLACEABLE. Every tile-and-face the cell has not ruled out, each carrying
   * the directions and modes that admit it. This is a candidate list, never a
   * move list: `validate.ts` takes these to the real validator.
   */
  candidatesAt(cell) {
    if (!inRange(cell) || !this.isReachable(cell)) return [];
    const cached = this.#candidateCache.get(cell);
    if (cached !== void 0) return cached;
    const mask = this.directionsAt(cell);
    const supports = /* @__PURE__ */ new Map();
    const kindsHere = /* @__PURE__ */ new Set();
    for (const direction of DIRECTIONS) {
      if (!mask.has(direction)) continue;
      const constraint = this.constraintsAt(cell, direction);
      const best = this.#cheapestPath(cell, direction);
      for (const face of constraint.allowed.faces) {
        const list = supports.get(face) ?? [];
        for (const mode of mask.modesOf(direction)) {
          list.push({
            direction,
            axis: constraint.axis,
            mode,
            cost: constraint.minCost ?? 0,
            origin: best?.origin ?? cell,
            pathId: best?.id ?? null
          });
        }
        supports.set(face, list);
      }
      for (const kind of constraint.allowed.kinds) kindsHere.add(kind);
    }
    const built = [];
    for (const [face, list] of supports) {
      list.sort((a, b) => a.cost - b.cost);
      for (const kind of KINDS_BY_FACE.get(face) ?? []) {
        if (!kindsHere.has(kind)) continue;
        built.push({
          id: `${cell}:${kind}:${face}`,
          cell,
          kind,
          face,
          assigned: needsAssignment(kind),
          supports: list,
          minCost: list[0]?.cost ?? 0,
          required: kindsHere.size === 1
        });
      }
    }
    built.sort((a, b) => a.face === b.face ? a.kind.localeCompare(b.kind) : compareFaces(a, b));
    this.#candidateCache.set(cell, built);
    return built;
  }
  candidates() {
    const out = [];
    for (const cell of this.reachableCells()) out.push(...this.candidatesAt(cell));
    return out;
  }
  /** The cheapest witness path arriving at a cell in one direction. */
  #cheapestPath(cell, direction) {
    let best;
    for (const path of this.pathsTo(cell)) {
      if (path.direction !== direction) continue;
      if (best === void 0 || path.cost < best.cost) best = path;
    }
    return best;
  }
  params() {
    return this.#resolved;
  }
  stats() {
    if (this.#cachedStats !== null) return this.#cachedStats;
    let reachableCells = 0;
    let directionalOpenings = 0;
    let crossOpenings = 0;
    let extendOpenings = 0;
    let hookOpenings = 0;
    let seedOpenings = 0;
    let cellsWithOnePath = 0;
    let cellsWithMultiplePaths = 0;
    let blockedCells = 0;
    let candidates = 0;
    let cellsWithOneKind = 0;
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      const bits = this.#propagation.openMask[cell];
      if (bits !== 0) {
        reachableCells += 1;
        for (const direction of DIRECTIONS) {
          if ((bits & directionBits(direction)) !== 0) directionalOpenings += 1;
          if ((bits & maskBit(direction, "cross")) !== 0) crossOpenings += 1;
          if ((bits & maskBit(direction, "extend")) !== 0) extendOpenings += 1;
          if ((bits & maskBit(direction, "hook")) !== 0) hookOpenings += 1;
          if ((bits & maskBit(direction, "seed")) !== 0) seedOpenings += 1;
        }
      }
      if (bits !== 0) {
        const list = this.candidatesAt(cell);
        candidates += list.length;
        if (list.length > 0 && new Set(list.map((item) => item.kind)).size === 1) {
          cellsWithOneKind += 1;
        }
      }
      const paths = this.#propagation.statesByCell[cell].length;
      if (paths === 1) cellsWithOnePath += 1;
      else if (paths > 1) cellsWithMultiplePaths += 1;
      if (this.#constraints.isBlocked(cell, "vertical") || this.#constraints.isBlocked(cell, "horizontal")) {
        blockedCells += 1;
      }
    }
    let maxDepth = 0;
    for (const state of this.#propagation.states) {
      if (state.cost > maxDepth) maxDepth = state.cost;
    }
    this.#cachedStats = {
      reachableCells,
      directionalOpenings,
      paths: this.#propagation.states.length,
      cellsWithOnePath,
      cellsWithMultiplePaths,
      maxDepth,
      anchors: this.#anchorList.length,
      blockedCells,
      candidates,
      cellsWithOneKind,
      crossOpenings,
      extendOpenings,
      hookOpenings,
      seedOpenings,
      truncated: this.#propagation.truncated
    };
    return this.#cachedStats;
  }
  #materialise(state, index) {
    const chain = [];
    for (let node = state; node !== null; node = node.parent) chain.push(node);
    chain.reverse();
    const steps = chain.map((node) => ({
      cell: node.cell,
      direction: node.direction,
      kind: node.kind,
      cost: node.cost,
      through: node.through
    }));
    const cells = chain.map((node) => node.cell);
    const boardCells = [...state.anchor.source];
    for (const node of chain) boardCells.push(...node.through);
    const probes = [];
    for (const node of chain) {
      if (node.probe !== null) probes.push(node.probe);
    }
    const constraints = chain.map((node) => this.constraintsAt(node.cell, node.direction));
    const required = [];
    for (const constraint of constraints) {
      if (constraint.allowed.unconstrained) continue;
      if (constraint.allowed.kinds.length === 1) {
        const only = constraint.allowed.kinds[0];
        if (!required.includes(only)) required.push(only);
      }
    }
    return {
      id: `${state.anchor.index}-${state.mode}-${state.direction}-${state.cell}-${index}`,
      anchorId: anchorId(state.anchor),
      origin: chain[0].cell,
      target: state.cell,
      direction: state.direction,
      mode: state.mode,
      cost: state.cost,
      depth: chain.length,
      cells,
      steps,
      boardCells: dedupe(boardCells),
      probes,
      constraints,
      requiredKinds: required
    };
  }
};
var KINDS_BY_FACE = (() => {
  const out = /* @__PURE__ */ new Map();
  for (const kind of Object.keys(TOKENS)) {
    const faces = needsAssignment(kind) ? assignmentOptions(kind) : [TOKENS[kind].face];
    for (const face of faces) {
      const list = out.get(face) ?? [];
      list.push(kind);
      out.set(face, list);
    }
  }
  return out;
})();
function compareFaces(a, b) {
  const rank = (face) => {
    const value2 = Number.parseInt(face, 10);
    return Number.isNaN(value2) ? [1, face] : [0, value2];
  };
  const [ra, va] = rank(a.face);
  const [rb, vb] = rank(b.face);
  if (ra !== rb) return ra - rb;
  if (typeof va === "number" && typeof vb === "number") return va - vb;
  return String(va).localeCompare(String(vb));
}
function inRange(cell) {
  return Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT;
}
function dedupe(cells) {
  return [...new Set(cells)].sort((a, b) => a - b);
}
function anchorId(anchor) {
  return `a${anchor.index}:${anchor.cell}:${anchor.direction}:${anchor.mode}`;
}
function toAnchor(anchor) {
  return {
    id: anchorId(anchor),
    cell: anchor.cell,
    direction: anchor.direction,
    mode: anchor.mode,
    axis: anchor.axis,
    source: anchor.source
  };
}
function createSpaceMap(input) {
  return new SpaceMapImpl(input);
}

// ../amath-bot-lab/src/space-map/buildSpaceMap.ts
var DEFAULT_MAX_STATES = 2e5;
function resolveParams(rules, options) {
  const requested = options?.maxNewTiles ?? rules.rackSize;
  return {
    maxNewTiles: Math.max(1, Math.min(255, Math.floor(requested))),
    maxStates: Math.max(1, Math.floor(options?.maxStates ?? DEFAULT_MAX_STATES)),
    ruleSetId: rules.id
  };
}
function buildSpaceMap(position, options) {
  return buildFromBoard(position.board, position.rules, options);
}
function buildFromBoard(board, rules, options) {
  const params = resolveParams(rules, options);
  const constraints = new ConstraintTable(board, rules);
  const anchors = findAnchors(board, constraints);
  const propagation = propagate(board, constraints, anchors, {
    maxNewTiles: params.maxNewTiles,
    maxStates: params.maxStates
  });
  const boardVersion = boardVersionOf(board);
  const id = `sm-${fnv1a(
    `${boardVersion}|${params.ruleSetId}|${params.maxNewTiles}|${params.maxStates}`
  )}`;
  return createSpaceMap({ id, boardVersion, params, constraints, propagation });
}
function boardVersionOf(board) {
  const parts = [];
  for (let cell = 0; cell < board.length; cell += 1) {
    const tile = board[cell];
    if (tile) parts.push(`${cell}:${tile.face}`);
  }
  return `bv-${fnv1a(parts.join(","))}-${parts.length}`;
}
function fnv1a(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash ^ BigInt(text.charCodeAt(i))) & mask;
    hash = hash * prime & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

// ../amath-bot-lab/src/space-map/spans.ts
var UNREACHABLE = 255;
var VERTICAL = 0;
var HORIZONTAL = 1;
function slot(cell, axis) {
  return cell * 2 + (axis === "vertical" ? VERTICAL : HORIZONTAL);
}
function buildSpanIndex(map, board) {
  const cut = new Uint8Array(CELL_COUNT * 2);
  const spanOf = new Int16Array(CELL_COUNT * 2).fill(-1);
  const tokens = new Uint8Array(CELL_COUNT * 2);
  const free = new Uint8Array(CELL_COUNT * 2);
  const equals2 = new Uint8Array(CELL_COUNT * 2).fill(UNREACHABLE);
  const byAxis = { vertical: [], horizontal: [] };
  for (const axis of ["vertical", "horizontal"]) {
    const direction = axis === "vertical" ? "down" : "right";
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      if (board[cell]) continue;
      if (map.constraintsAt(cell, direction).blocked) cut[slot(cell, axis)] = 1;
    }
    for (let line2 = 0; line2 < BOARD_SIZE; line2 += 1) {
      const lineCells = [];
      for (let step = 0; step < BOARD_SIZE; step += 1) {
        lineCells.push(axis === "vertical" ? cellAt(step, line2) : cellAt(line2, step));
      }
      let index = 0;
      while (index < lineCells.length) {
        if (cut[slot(lineCells[index], axis)] === 1) {
          index += 1;
          continue;
        }
        const start = index;
        while (index < lineCells.length && cut[slot(lineCells[index], axis)] === 0) index += 1;
        const cells = lineCells.slice(start, index);
        const span = {
          axis,
          from: cells[0],
          to: cells[cells.length - 1],
          cells,
          capacity: cells.filter((cell) => !board[cell]).length,
          tokens: cells.length
        };
        const id = byAxis[axis].length;
        byAxis[axis].push(span);
        for (let at = cells.length - 1; at >= 0; at -= 1) {
          const cell = cells[at];
          const here = slot(cell, axis);
          const next = at + 1 < cells.length ? slot(cells[at + 1], axis) : -1;
          spanOf[here] = id;
          tokens[here] = Math.min(255, cells.length - at);
          free[here] = board[cell] ? next < 0 ? 1 : Math.min(255, (free[next] ?? 0) + 1) : 0;
          const tile = board[cell];
          if (tile && isEqualsFace(tile.face)) {
            equals2[here] = 0;
          } else if (next >= 0 && (equals2[next] ?? UNREACHABLE) !== UNREACHABLE) {
            equals2[here] = Math.min(UNREACHABLE, (equals2[next] ?? 0) + (tile ? 0 : 1));
          }
        }
      }
    }
  }
  return {
    isCut: (cell, axis) => inRange2(cell) && cut[slot(cell, axis)] === 1,
    at: (cell, axis) => {
      if (!inRange2(cell)) return null;
      const id = spanOf[slot(cell, axis)] ?? -1;
      return id < 0 ? null : byAxis[axis][id] ?? null;
    },
    sameSpan: (a, b, axis) => {
      if (!inRange2(a) || !inRange2(b)) return false;
      if (axis === "vertical" ? colOf(a) !== colOf(b) : rowOf(a) !== rowOf(b)) return false;
      const first = spanOf[slot(a, axis)] ?? -1;
      return first >= 0 && first === (spanOf[slot(b, axis)] ?? -1);
    },
    tokensAhead: (cell, axis) => inRange2(cell) ? tokens[slot(cell, axis)] ?? 0 : 0,
    freeTokensAhead: (cell, axis) => inRange2(cell) ? free[slot(cell, axis)] ?? 0 : 0,
    equalsCost: (cell, axis) => inRange2(cell) ? equals2[slot(cell, axis)] ?? UNREACHABLE : UNREACHABLE,
    spans: (axis) => byAxis[axis]
  };
}
function inRange2(cell) {
  return Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT;
}

// ../amath-bot-lab/src/core/validator.ts
function validatePlacement(board, placements, rules) {
  const problems = [];
  if (placements.length === 0) {
    return {
      legal: false,
      diagnostics: [diagnostic("NO_TILES_PLACED", "\u0E22\u0E31\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E27\u0E32\u0E07\u0E40\u0E1A\u0E35\u0E49\u0E22")],
      runs: []
    };
  }
  const pending = /* @__PURE__ */ new Map();
  let geometryUsable = true;
  for (const placement of placements) {
    const { cell } = placement;
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) {
      problems.push(diagnostic("OUT_OF_BOARD", "\u0E21\u0E35\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E2D\u0E22\u0E39\u0E48\u0E19\u0E2D\u0E01\u0E01\u0E23\u0E30\u0E14\u0E32\u0E19", { cells: [cell] }));
      geometryUsable = false;
      continue;
    }
    if (board[cell]) {
      problems.push(diagnostic("CELL_OCCUPIED", "\u0E27\u0E32\u0E07\u0E17\u0E31\u0E1A\u0E0A\u0E48\u0E2D\u0E07\u0E17\u0E35\u0E48\u0E21\u0E35\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E2D\u0E22\u0E39\u0E48\u0E41\u0E25\u0E49\u0E27", { cells: [cell] }));
      geometryUsable = false;
    }
    if (pending.has(cell)) {
      problems.push(
        diagnostic("DUPLICATE_CELL", "\u0E27\u0E32\u0E07\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E2A\u0E2D\u0E07\u0E15\u0E31\u0E27\u0E43\u0E19\u0E0A\u0E48\u0E2D\u0E07\u0E40\u0E14\u0E35\u0E22\u0E27\u0E01\u0E31\u0E19", { cells: [cell] })
      );
      geometryUsable = false;
    } else {
      pending.set(cell, placement);
    }
    const info = TOKENS[placement.kind];
    if (needsAssignment(placement.kind)) {
      if (!placement.face) {
        problems.push(
          diagnostic("UNASSIGNED_CHOICE", `\u0E15\u0E49\u0E2D\u0E07\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E04\u0E48\u0E32\u0E43\u0E2B\u0E49\u0E40\u0E1A\u0E35\u0E49\u0E22 ${info.face}`, { cells: [cell] })
        );
      } else if (!assignmentOptions(placement.kind).includes(placement.face)) {
        problems.push(
          diagnostic(
            "ILLEGAL_ASSIGNMENT",
            `\u0E40\u0E1A\u0E35\u0E49\u0E22 ${info.face} \u0E40\u0E25\u0E37\u0E2D\u0E01\u0E40\u0E1B\u0E47\u0E19 "${placement.face}" \u0E44\u0E21\u0E48\u0E44\u0E14\u0E49`,
            {
              cells: [cell]
            }
          )
        );
      }
    } else if (placement.face !== info.face) {
      problems.push(
        diagnostic(
          "ILLEGAL_ASSIGNMENT",
          `\u0E40\u0E1A\u0E35\u0E49\u0E22 ${info.face} \u0E40\u0E1B\u0E25\u0E35\u0E48\u0E22\u0E19\u0E2B\u0E19\u0E49\u0E32\u0E40\u0E1B\u0E47\u0E19 "${placement.face}" \u0E44\u0E21\u0E48\u0E44\u0E14\u0E49`,
          {
            cells: [cell]
          }
        )
      );
    }
  }
  const cells = placements.map((p) => p.cell).filter((cell) => cell >= 0 && cell < CELL_COUNT);
  const rows = new Set(cells.map(rowOf));
  const cols = new Set(cells.map(colOf));
  const sameRow = rows.size === 1;
  const sameCol = cols.size === 1;
  if (!sameRow && !sameCol) {
    problems.push(
      diagnostic("NOT_SINGLE_LINE", "\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E17\u0E35\u0E48\u0E27\u0E32\u0E07\u0E43\u0E19\u0E2B\u0E19\u0E36\u0E48\u0E07\u0E40\u0E17\u0E34\u0E23\u0E4C\u0E19\u0E15\u0E49\u0E2D\u0E07\u0E2D\u0E22\u0E39\u0E48\u0E41\u0E16\u0E27\u0E40\u0E14\u0E35\u0E22\u0E27\u0E2B\u0E23\u0E37\u0E2D\u0E04\u0E2D\u0E25\u0E31\u0E21\u0E19\u0E4C\u0E40\u0E14\u0E35\u0E22\u0E27", {
        cells
      })
    );
    geometryUsable = false;
  } else if (cells.length > 0) {
    const horizontal = sameRow && (!sameCol || cells.length === 1);
    const line2 = horizontal ? cells.map(colOf) : cells.map(rowOf);
    const fixed = horizontal ? rowOf(cells[0]) : colOf(cells[0]);
    const min = Math.min(...line2);
    const max = Math.max(...line2);
    const gaps = [];
    for (let value2 = min; value2 <= max; value2 += 1) {
      const cell = horizontal ? cellAt(fixed, value2) : cellAt(value2, fixed);
      if (!board[cell] && !pending.has(cell)) gaps.push(cell);
    }
    if (gaps.length > 0) {
      problems.push(
        diagnostic("GAP_IN_LINE", "\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E17\u0E35\u0E48\u0E27\u0E32\u0E07\u0E15\u0E49\u0E2D\u0E07\u0E15\u0E48\u0E2D\u0E40\u0E19\u0E37\u0E48\u0E2D\u0E07\u0E01\u0E31\u0E19 \u0E2B\u0E49\u0E32\u0E21\u0E40\u0E27\u0E49\u0E19\u0E0A\u0E48\u0E2D\u0E07", { cells: gaps })
      );
    }
  }
  if (isBoardEmpty(board)) {
    if (!cells.includes(CENTER_INDEX)) {
      problems.push(
        diagnostic("MISSING_CENTER_STAR", "\u0E2A\u0E21\u0E01\u0E32\u0E23\u0E41\u0E23\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E17\u0E31\u0E1A\u0E0A\u0E48\u0E2D\u0E07\u0E14\u0E32\u0E27\u0E01\u0E25\u0E32\u0E07\u0E01\u0E23\u0E30\u0E14\u0E32\u0E19", {
          cells: [CENTER_INDEX]
        })
      );
    }
  } else {
    const touches = cells.some(
      (cell) => neighbours(cell).some((neighbour) => Boolean(board[neighbour]))
    );
    if (!touches) {
      problems.push(
        diagnostic("NOT_CONNECTED", "\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E17\u0E35\u0E48\u0E27\u0E32\u0E07\u0E43\u0E2B\u0E21\u0E48\u0E15\u0E49\u0E2D\u0E07\u0E40\u0E0A\u0E37\u0E48\u0E2D\u0E21\u0E01\u0E31\u0E1A\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E40\u0E14\u0E34\u0E21\u0E1A\u0E19\u0E01\u0E23\u0E30\u0E14\u0E32\u0E19", { cells })
      );
    }
  }
  const runs = geometryUsable ? collectRuns(board, pending) : [];
  const runResults = [];
  for (const run2 of runs) {
    const analysis = analyzeRun(run2.tokens, rules);
    problems.push(...analysis.diagnostics);
    runResults.push({
      cells: run2.cells,
      tokens: run2.tokens,
      text: runText(run2.tokens),
      direction: run2.direction,
      valid: analysis.diagnostics.length === 0
    });
  }
  if (geometryUsable && runResults.length === 0) {
    problems.push(diagnostic("NO_EQUATION", "\u0E01\u0E32\u0E23\u0E27\u0E32\u0E07\u0E19\u0E35\u0E49\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49\u0E2A\u0E23\u0E49\u0E32\u0E07\u0E2A\u0E21\u0E01\u0E32\u0E23\u0E43\u0E14\u0E40\u0E25\u0E22", { cells }));
  }
  return { legal: problems.length === 0, diagnostics: problems, runs: runResults };
}
function neighbours(cell) {
  const row = rowOf(cell);
  const col = colOf(cell);
  const result = [];
  if (row > 0) result.push(cellAt(row - 1, col));
  if (row < BOARD_SIZE - 1) result.push(cellAt(row + 1, col));
  if (col > 0) result.push(cellAt(row, col - 1));
  if (col < BOARD_SIZE - 1) result.push(cellAt(row, col + 1));
  return result;
}
function collectRuns(board, pending) {
  const faceAt2 = (cell) => {
    const placed = pending.get(cell);
    if (placed) return placed.face;
    const existing = board[cell];
    return existing ? existing.face : null;
  };
  const seen = /* @__PURE__ */ new Set();
  const runs = [];
  for (const cell of pending.keys()) {
    for (const direction of ["horizontal", "vertical"]) {
      const row = rowOf(cell);
      const col = colOf(cell);
      let startRow = row;
      let startCol = col;
      const stepRow = direction === "vertical" ? 1 : 0;
      const stepCol = direction === "horizontal" ? 1 : 0;
      while (startRow - stepRow >= 0 && startCol - stepCol >= 0 && faceAt2(cellAt(startRow - stepRow, startCol - stepCol)) !== null) {
        startRow -= stepRow;
        startCol -= stepCol;
      }
      const tokens = [];
      const runCells = [];
      let r = startRow;
      let c = startCol;
      while (r < BOARD_SIZE && c < BOARD_SIZE) {
        const current = cellAt(r, c);
        const face = faceAt2(current);
        if (face === null) break;
        tokens.push({ face, cell: current });
        runCells.push(current);
        r += stepRow;
        c += stepCol;
      }
      if (tokens.length < 2) continue;
      const key = `${direction}:${runCells[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      runs.push({ cells: runCells, tokens, direction });
    }
  }
  return runs;
}

// ../amath-bot-lab/src/move-generator/rackState.ts
function facesOf(kind) {
  return needsAssignment(kind) ? assignmentOptions(kind) : [TOKENS[kind].face];
}
var RackState = class {
  #order = [];
  #index = /* @__PURE__ */ new Map();
  #counts;
  #ids = [];
  #remaining = 0;
  constructor(tiles) {
    const counts = /* @__PURE__ */ new Map();
    const pools = /* @__PURE__ */ new Map();
    for (const tile of tiles) {
      const count = counts.get(tile.kind) ?? 0;
      if (count === 0) this.#order.push(tile.kind);
      counts.set(tile.kind, count + 1);
      pools.set(tile.kind, [...pools.get(tile.kind) ?? [], tile.id]);
      this.#remaining += 1;
    }
    this.#order.sort();
    this.#counts = new Uint8Array(this.#order.length);
    this.#order.forEach((kind, at) => {
      this.#index.set(kind, at);
      this.#counts[at] = counts.get(kind) ?? 0;
      this.#ids.push(pools.get(kind) ?? []);
    });
  }
  /** Kinds still held, at least one each, in a stable order. */
  get kinds() {
    return this.#order;
  }
  get remaining() {
    return this.#remaining;
  }
  /**
   * How many of each kind are left, by index in `kinds`.
   *
   * Handed out so the search can read it straight rather than call `hasAt` tens
   * of millions of times. It is the live array, not a copy — reading it is the
   * point — and nothing outside this class may write to it.
   */
  get counts() {
    return this.#counts;
  }
  /** Where a kind sits in `kinds`, or -1. The index is the hot-path handle. */
  indexOf(kind) {
    return this.#index.get(kind) ?? -1;
  }
  hasAt(at) {
    return this.#counts[at] > 0;
  }
  takeAt(at) {
    const count = this.#counts[at];
    if (count === 0) throw new Error(`rack has no ${this.#order[at]} left`);
    this.#counts[at] = count - 1;
    this.#remaining -= 1;
  }
  giveAt(at) {
    this.#counts[at] = this.#counts[at] + 1;
    this.#remaining += 1;
  }
  has(kind) {
    const at = this.indexOf(kind);
    return at >= 0 && this.hasAt(at);
  }
  take(kind) {
    const at = this.indexOf(kind);
    if (at < 0) throw new Error(`rack has no ${kind} left`);
    this.takeAt(at);
  }
  give(kind) {
    const at = this.indexOf(kind);
    if (at < 0) throw new Error(`rack never held a ${kind}`);
    this.giveAt(at);
  }
  /**
   * Hand out concrete tile ids for a finished move. Which physical `2` is spent
   * does not change the move's identity, so any consistent choice will do —
   * but it must be consistent, or the same move would look like two.
   */
  idsFor(kinds) {
    const taken = /* @__PURE__ */ new Map();
    return kinds.map((kind) => {
      const index = taken.get(kind) ?? 0;
      taken.set(kind, index + 1);
      const at = this.indexOf(kind);
      const id = at < 0 ? void 0 : this.#ids[at]?.[index];
      if (id === void 0) throw new Error(`rack cannot supply ${index + 1} of ${kind}`);
      return id;
    });
  }
};

// ../amath-bot-lab/src/move-generator/expansion.ts
var BRANCH_PLAIN = 0;
var BRANCH_BLANK = 1;
var BRANCH_CHOICE = 2;
var DIRECTION_OF = { vertical: "down", horizontal: "right" };
var FaceGate = class {
  #map;
  #table;
  #ignore;
  #kinds;
  #cache = new Array(CELL_COUNT * 2);
  /** `#byFace[slot][faceId]` — the options at that cell wearing that face. */
  #byFace = new Array(CELL_COUNT * 2);
  /** `kinds` is the rack's kind list, which does not change during a search. */
  constructor(map, table, kinds = [], ignoreSpaceMap = false) {
    this.#map = map;
    this.#table = table;
    this.#ignore = ignoreSpaceMap;
    this.#kinds = kinds;
  }
  /** Faces the cell admits, or null when nothing constrains it. */
  allowed(cell, axis) {
    if (this.#ignore) return null;
    const constraint = this.#map.constraintsAt(cell, DIRECTION_OF[axis]);
    return constraint.allowed.unconstrained ? null : new Set(constraint.allowed.faces);
  }
  /**
   * What each rack kind may become at this cell, computed once and kept.
   *
   * The answer depends on the cell, the axis and the board, and none of those
   * move during a search — so the search asks once however many million times
   * it walks over the cell. The option objects are shared too: they are frozen
   * facts about a cell, not per-visit values.
   */
  optionsAt(cell, axis) {
    return this.optionsAtSlot(cell * 2 + (axis === "vertical" ? 0 : 1));
  }
  /** The same, addressed the way the search already holds it: `cell * 2 + axis`. */
  optionsAtSlot(slot2) {
    const cell = slot2 >> 1;
    const axis = (slot2 & 1) === 0 ? "vertical" : "horizontal";
    const cached = this.#cache[slot2];
    if (cached !== void 0) return cached;
    const allowed = this.allowed(cell, axis);
    const groups = this.#kinds.map((kind, kindAt2) => {
      const faces = [];
      let pruned = 0;
      for (const face of facesOf(kind)) {
        if (allowed !== null && !allowed.has(face)) pruned += 1;
        else
          faces.push({
            kind,
            face,
            faceId: this.#table.idOf(face),
            kindAt: kindAt2,
            branch: branchOf(kind)
          });
      }
      return { kind, faces, pruned, kindAt: kindAt2 };
    });
    this.#cache[slot2] = groups;
    return groups;
  }
  /**
   * The options at this cell that wear exactly this face, in the same order
   * `optionsAt` would have walked them.
   *
   * The closing solve names ONE face that could finish a line. Where the line
   * can go no further that face is the only one worth trying, and asking for it
   * by name beats walking every face the cell admits and comparing — on a full
   * rack with two blanks that walk is a third of all the work the search does.
   * It is a lookup, not a rule: the set it hands back is exactly the set the
   * walk would have kept.
   */
  optionsForFace(cell, axis, faceId) {
    const slot2 = cell * 2 + (axis === "vertical" ? 0 : 1);
    let index = this.#byFace[slot2];
    if (index === void 0) {
      const built = Array.from({ length: this.#table.count }, () => []);
      for (const group of this.optionsAt(cell, axis)) {
        for (const option of group.faces) built[option.faceId]?.push(option);
      }
      index = built;
      this.#byFace[slot2] = index;
    }
    return index[faceId] ?? NO_OPTIONS;
  }
};
var NO_OPTIONS = Object.freeze([]);
function branchOf(kind) {
  if (kind === "?") return BRANCH_BLANK;
  return TOKENS[kind].type === "choice" ? BRANCH_CHOICE : BRANCH_PLAIN;
}
function expandCell(gate, cell, axis, rack) {
  const options = [];
  let pruned = 0;
  for (const group of gate.optionsAt(cell, axis)) {
    if (!rack.hasAt(group.kindAt)) continue;
    pruned += group.pruned;
    for (const option of group.faces) options.push(option);
  }
  return { options, pruned };
}
function routable(map, cell, axis) {
  const mask = map.directionsAt(cell);
  return axis === "vertical" ? mask.has("up") || mask.has("down") : mask.has("left") || mask.has("right");
}

// ../amath-bot-lab/src/move-generator/moveCollector.ts
var MoveCollector = class {
  #byId = /* @__PURE__ */ new Map();
  #insertionOrder = null;
  #duplicates = 0;
  /** Returns false when this move was already found. */
  add(move) {
    const id = moveId(move.move);
    if (this.#byId.has(id)) {
      this.#duplicates += 1;
      return false;
    }
    const found = { ...move, id };
    this.#byId.set(id, found);
    this.#insertionOrder?.push(found);
    return true;
  }
  get duplicates() {
    return this.#duplicates;
  }
  get size() {
    return this.#byId.size;
  }
  /** Sorted by id, so two runs hand back the same list in the same order. */
  moves() {
    return [...this.#byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  /** Opt in to a discovery log; normal move generation keeps no second list. */
  trackDiscovery() {
    if (this.#insertionOrder === null) this.#insertionOrder = [...this.#byId.values()];
  }
  /** New unique moves in discovery order, for exact searches that stop after a proof cutoff. */
  movesSince(count) {
    if (this.#insertionOrder === null) throw new Error("Move discovery was not enabled");
    return this.#insertionOrder.slice(count);
  }
};

// ../amath-bot-lab/src/core/scorer.ts
function scorePlacement(board, placements, runs, rules) {
  const pending = /* @__PURE__ */ new Map();
  for (const placement of placements) pending.set(placement.cell, placement);
  const equations = runs.map((run2) => scoreRun(board, pending, run2));
  const equationTotal = equations.reduce((sum2, equation) => sum2 + equation.subtotal, 0);
  const bingoBonus = placements.length >= rules.rackSize ? rules.bingoBonus : 0;
  return { equations, equationTotal, bingoBonus, total: equationTotal + bingoBonus };
}
function scoreRun(board, pending, run2) {
  let sum2 = 0;
  let multiplier = 1;
  const tiles = [];
  for (const cell of run2.cells) {
    const placed = pending.get(cell);
    const existing = board[cell];
    const kind = placed ? placed.kind : existing?.kind;
    const face = placed ? placed.face : existing?.face ?? "";
    if (kind === void 0) continue;
    const basePoint = TOKENS[kind].point;
    const isNew = placed !== void 0;
    const slot2 = isNew ? slotAt(cell) : "px1";
    let points = basePoint;
    if (slot2 === "px2") points = basePoint * 2;
    else if (slot2 === "px3" || slot2 === "px3star") points = basePoint * 3;
    else if (slot2 === "ex2") multiplier *= 2;
    else if (slot2 === "ex3") multiplier *= 3;
    sum2 += points;
    tiles.push({ cell, kind, face, basePoint, slot: slot2, isNew, points });
  }
  return { cells: run2.cells, text: run2.text, tiles, multiplier, subtotal: sum2 * multiplier };
}

// ../amath-bot-lab/src/core/incrementalSide.ts
function emptySide() {
  return {
    dead: false,
    count: 0,
    sum: ZERO,
    sumOp: null,
    term: null,
    termOp: null,
    digitCount: 0,
    digitValue: 0,
    digitBig: null,
    tens: null,
    negate: false
  };
}
var SMALL = Array.from({ length: 1e3 }, (_, value2) => fromInt(value2));
var SAFE_DIGITS = 15;
function wholeOf(value2) {
  return value2 < 1e3 ? SMALL[value2] : fromInt(value2);
}
function readingValue(state) {
  if (state.tens !== null) return SMALL[state.tens];
  if (state.digitBig !== null) return fromInt(state.digitBig);
  return wholeOf(state.digitValue);
}
function reading(state) {
  return state.digitCount > 0 || state.tens !== null;
}
function resetSide(state) {
  state.dead = false;
  state.count = 0;
  state.sum = ZERO;
  state.sumOp = null;
  state.term = null;
  state.termOp = null;
  state.digitCount = 0;
  state.digitValue = 0;
  state.digitBig = null;
  state.tens = null;
  state.negate = false;
}
function pushSideId(state, table, id) {
  const category = table.category[id];
  if (category === CAT_UNIT) {
    state.count += 1;
    if (state.tens !== null) {
      state.dead = true;
      return;
    }
    const digit = table.digit[id];
    state.digitCount += 1;
    if (state.digitBig !== null) state.digitBig = state.digitBig * 10n + BigInt(digit);
    else if (state.digitCount > SAFE_DIGITS) {
      state.digitBig = BigInt(state.digitValue) * 10n + BigInt(digit);
    } else state.digitValue = state.digitValue * 10 + digit;
    return;
  }
  if (category === CAT_TENS) {
    state.count += 1;
    if (state.digitCount > 0 || state.tens !== null) state.dead = true;
    else state.tens = table.tens[id];
    return;
  }
  const mark = table.mark[id];
  if (state.count === 0) {
    state.count = 1;
    if (mark === MARK_MINUS) state.negate = true;
    else state.dead = true;
    return;
  }
  state.count += 1;
  if (!closeNumber(state)) return;
  if (mark === MARK_TIMES || mark === MARK_DIVIDE) {
    state.termOp = mark === MARK_TIMES ? "*" : "/";
    return;
  }
  if (mark === MARK_PLUS || mark === MARK_MINUS) {
    closeTerm(state);
    state.sumOp = mark === MARK_PLUS ? "+" : "-";
    return;
  }
  state.dead = true;
}
function sideValue(state) {
  if (state.dead) return null;
  if (!reading(state)) return null;
  let value2 = readingValue(state);
  if (state.negate) value2 = neg(value2);
  let term;
  if (state.termOp === null) {
    term = value2;
  } else if (state.termOp === "*") {
    term = mul(state.term, value2);
  } else {
    const quotient = div(state.term, value2);
    if (quotient === null) return null;
    term = quotient;
  }
  if (state.sumOp === null) return term;
  return state.sumOp === "+" ? add(state.sum, term) : sub(state.sum, term);
}
function closeNumber(state) {
  if (state.dead) return false;
  if (!reading(state)) {
    state.dead = true;
    return false;
  }
  let value2 = readingValue(state);
  if (state.negate) {
    value2 = neg(value2);
    state.negate = false;
  }
  if (state.termOp === null) {
    state.term = value2;
  } else if (state.termOp === "*") {
    state.term = mul(state.term, value2);
  } else {
    const quotient = div(state.term, value2);
    if (quotient === null) {
      state.dead = true;
      return false;
    }
    state.term = quotient;
  }
  state.termOp = null;
  state.digitCount = 0;
  state.digitValue = 0;
  state.digitBig = null;
  state.tens = null;
  return true;
}
function closeTerm(state) {
  if (state.dead) return;
  const term = state.term;
  if (state.sumOp === null) state.sum = term;
  else state.sum = state.sumOp === "+" ? add(state.sum, term) : sub(state.sum, term);
  state.sumOp = null;
  state.term = null;
}
var REQUIRED_NONE = NOT_WHOLE;
var REQUIRED_ANY = -2;
function requiredFinalNumber(state, target) {
  if (state.dead) return REQUIRED_NONE;
  let term;
  if (state.sumOp === null) term = target;
  else if (state.sumOp === "+") term = sub(target, state.sum);
  else term = sub(state.sum, target);
  let value2;
  if (state.termOp === null) {
    value2 = term;
  } else if (state.termOp === "*") {
    const left = state.term;
    if (isZero(left)) return isZero(term) ? REQUIRED_ANY : REQUIRED_NONE;
    const quotient = div(term, left);
    if (quotient === null) return REQUIRED_NONE;
    value2 = quotient;
  } else {
    const left = state.term;
    if (isZero(term)) return isZero(left) ? REQUIRED_ANY : REQUIRED_NONE;
    const quotient = div(left, term);
    if (quotient === null || isZero(quotient)) return REQUIRED_NONE;
    value2 = quotient;
  }
  if (state.negate) value2 = neg(value2);
  return wholeNonNegative(value2);
}

// ../amath-bot-lab/src/move-generator/prefixState.ts
var NO_PROBLEM = -1;
var P_LEADING_OPERATOR = 0;
var P_ADJACENT_OPERATORS = 1;
var P_TENS_TOUCHING = 2;
var P_DIV_BY_ZERO = 3;
var P_MAX_3_DIGITS = 4;
var P_LEADING_ZERO = 5;
var P_NEGATIVE_ZERO = 6;
var P_MALFORMED_SIDE = 7;
var P_UNBALANCED = 8;
var P_MISSING_EQUALS = 9;
var P_TRAILING_OPERATOR = 10;
var PROBLEM_NAMES = [
  "LEADING_OPERATOR",
  "ADJACENT_OPERATORS",
  "TENS_TOUCHING",
  "DIV_BY_ZERO",
  "MAX_3_DIGITS",
  "LEADING_ZERO",
  "NEGATIVE_ZERO",
  "MALFORMED_SIDE",
  "UNBALANCED",
  "MISSING_EQUALS",
  "TRAILING_OPERATOR"
];
var PROBLEM_COUNT = PROBLEM_NAMES.length;
var ADJACENCY_PROBLEM = [
  P_ADJACENT_OPERATORS,
  P_TENS_TOUCHING,
  P_DIV_BY_ZERO
];
var KIND_GRAMMAR = 0;
var KIND_ARITHMETIC = 1;
var KIND_COMPLETION = 2;
var PROBLEM_KIND_CODE = new Uint8Array([
  KIND_GRAMMAR,
  KIND_GRAMMAR,
  KIND_GRAMMAR,
  KIND_GRAMMAR,
  KIND_GRAMMAR,
  KIND_GRAMMAR,
  KIND_GRAMMAR,
  KIND_ARITHMETIC,
  KIND_ARITHMETIC,
  KIND_COMPLETION,
  KIND_COMPLETION
]);
function problemName(code) {
  return PROBLEM_NAMES[code];
}
var POWERS_OF_TEN = [1, 10, 100, 1e3];
var CLOSES_NOTHING = -1;
var CLOSES_ANYTHING = -2;
function blankUndo() {
  return {
    digitRun: 0,
    digitBlockFirst: NO_FACE,
    sideStart: 0,
    pushedValue: false,
    trusted: true,
    dead: false,
    count: 0,
    sum: ZERO,
    sumOp: null,
    term: null,
    termOp: null,
    digitCount: 0,
    digitValue: 0,
    digitBig: null,
    tens: null,
    negate: false
  };
}
var PrefixState = class {
  #table;
  #ids = [];
  /** Reused down the depth of the line — see the note at the top of the file. */
  #undo = [];
  #depth = 0;
  #sideValues = [];
  #sideStart = 0;
  #digitRun = 0;
  #digitBlockFirst = NO_FACE;
  #equals = 0;
  /**
   * The face on the end of the line, and `#last * table.count` — the row of the
   * adjacency table it names. Both are read once per face TRIED, which is tens
   * of millions of times a search, and both change only when the line does.
   */
  #last = NO_FACE;
  #adjacencyRow = 0;
  /**
   * The side being built, evaluated as it grows. It answers the two questions
   * this class asks most — "what does the open side come to?" and "did the `=`
   * just placed balance?" — in constant time instead of re-parsing the line.
   * It is an optimisation and never an authority: `incremental-side.test.ts`
   * pins it to `evaluateSide` on every adjacency-legal sequence it can reach.
   */
  #side = emptySide();
  /**
   * False once `pushUnchecked` has put a face on that `#check` would have
   * refused. The running evaluator's precondition is then broken, so every
   * value falls back to the parser. Only `strict` mode can reach this.
   */
  #trusted = true;
  constructor(rules) {
    this.#table = faceTableFor(rules);
  }
  get table() {
    return this.#table;
  }
  get length() {
    return this.#ids.length;
  }
  get hasEquals() {
    return this.#equals > 0;
  }
  /** How many `=` the line holds so far. Never assumed to be one. */
  get equalsCount() {
    return this.#equals;
  }
  /** Values of the sides already closed by an `=`, in order. Exact rationals. */
  sideValues() {
    return this.#sideValues;
  }
  /**
   * Value of the side still being built, or null when it does not parse yet.
   * Shown by the audit panel as the arithmetic state of the current prefix.
   */
  openSideValue() {
    if (this.#ids.length === this.#sideStart) return null;
    return this.#openValue();
  }
  /** Digits sitting unbroken at the end of the prefix. */
  get digitRun() {
    return this.#digitRun;
  }
  get lastFaceId() {
    return this.#last;
  }
  /**
   * `lastFaceId * table.count`, or -1 when the line is empty.
   *
   * The row of the adjacency table the next face will be judged against. The
   * search reads it to settle the pair itself, in the loop, rather than call in
   * and be told: nine million of the faces it tries a search are refused for
   * their neighbour alone, and two calls each to find that out is two calls too
   * many. `push` applies the same row.
   */
  get adjacencyRow() {
    return this.#last === NO_FACE ? -1 : this.#adjacencyRow;
  }
  get lastFace() {
    const id = this.lastFaceId;
    return id === NO_FACE ? null : this.#table.faces[id];
  }
  faces() {
    return this.#ids.map((id) => this.#table.faces[id]);
  }
  /**
   * Add one face to the end of the line.
   *
   * Returns the rule it breaks — in which case the caller must NOT keep it and
   * must not call `pop` — or null, in which case the face is now part of the
   * prefix and `pop` will take it back off.
   */
  push(face) {
    const id = this.#table.idOf(face);
    if (id === NO_FACE) return "MALFORMED_SIDE";
    const code = this.pushId(id);
    return code === NO_PROBLEM ? null : PROBLEM_NAMES[code];
  }
  /**
   * Add one face to the end of the line, by id.
   *
   * Returns `NO_PROBLEM`, in which case the face is now part of the prefix and
   * `pop` will take it back off — or the code of the rule it breaks, in which
   * case the caller must NOT keep it and must not call `pop`.
   */
  pushId(id) {
    const shape = this.#checkShape(id);
    if (shape !== NO_PROBLEM) return shape;
    const isEquals = this.#table.equals[id] === 1;
    let closing = null;
    if (isEquals) {
      closing = this.#openValue();
      if (closing === null) return P_MALFORMED_SIDE;
      const first = this.#sideValues[0];
      if (first !== void 0 && !equals(closing, first)) return P_UNBALANCED;
    }
    const undo = this.#record();
    if (this.#table.category[id] === CAT_UNIT) {
      if (this.#digitRun === 0) this.#digitBlockFirst = id;
      this.#digitRun += 1;
    } else {
      this.#digitRun = 0;
      this.#digitBlockFirst = NO_FACE;
    }
    this.#push(id);
    if (isEquals) {
      this.#sideValues.push(closing);
      this.#sideStart = this.#ids.length;
      this.#equals += 1;
      resetSide(this.#side);
      undo.pushedValue = true;
      return NO_PROBLEM;
    }
    pushSideId(this.#side, this.#table, id);
    return NO_PROBLEM;
  }
  /**
   * Add a face WITHOUT judging it. Only `strict` mode uses this: it searches on
   * through prefixes the pruner would have stopped at, so a test can show the
   * two find the same moves. Never call it on the fast path.
   */
  pushUnchecked(face) {
    const id = this.#table.idOf(face);
    this.pushUncheckedId(id === NO_FACE ? 0 : id);
  }
  pushUncheckedId(id) {
    const undo = this.#record();
    if (this.#table.category[id] === CAT_UNIT) {
      if (this.#digitRun === 0) this.#digitBlockFirst = id;
      this.#digitRun += 1;
    } else {
      this.#digitRun = 0;
      this.#digitBlockFirst = NO_FACE;
    }
    this.#trusted = false;
    this.#push(id);
    if (this.#table.equals[id] === 1) {
      const value2 = evaluateSide(this.faces().slice(this.#sideStart, this.#ids.length - 1));
      this.#sideValues.push(value2 ?? fromInt(0n));
      this.#sideStart = this.#ids.length;
      this.#equals += 1;
      resetSide(this.#side);
      undo.pushedValue = true;
      return;
    }
    pushSideId(this.#side, this.#table, id);
  }
  pop() {
    if (this.#depth === 0) throw new Error("prefix underflow");
    this.#depth -= 1;
    const undo = this.#undo[this.#depth];
    this.#ids.pop();
    const last = this.#ids.length === 0 ? NO_FACE : this.#ids[this.#ids.length - 1];
    this.#last = last;
    this.#adjacencyRow = last === NO_FACE ? 0 : last * this.#table.count;
    this.#digitRun = undo.digitRun;
    this.#digitBlockFirst = undo.digitBlockFirst;
    this.#sideStart = undo.sideStart;
    this.#trusted = undo.trusted;
    const side = this.#side;
    side.dead = undo.dead;
    side.count = undo.count;
    side.sum = undo.sum;
    side.sumOp = undo.sumOp;
    side.term = undo.term;
    side.termOp = undo.termOp;
    side.digitCount = undo.digitCount;
    side.digitValue = undo.digitValue;
    side.digitBig = undo.digitBig;
    side.tens = undo.tens;
    side.negate = undo.negate;
    if (undo.pushedValue) {
      this.#sideValues.pop();
      this.#equals -= 1;
    }
  }
  /**
   * Could the line, ending exactly where it does now, be a complete equation?
   *
   * A NECESSARY condition, not a sufficient one: everything it accepts still
   * goes to `validatePlacement`. What it saves is reading the whole run again
   * for the overwhelming majority of prefixes that cannot possibly close —
   * the sides before the last one were evaluated when their `=` landed and
   * their values are still here, so only the last side has to be worked out.
   *
   * Between this and `push`, every rule `analyzeRun` knows is covered: the
   * pairwise ones and the number rules on the way in, and missing `=`, a
   * trailing sign, an unreadable side and an unbalanced one on the way out.
   */
  closeProblem() {
    const code = this.closeProblemCode();
    return code === NO_PROBLEM ? null : PROBLEM_NAMES[code];
  }
  /** The same question, answered by code. What the search asks. */
  closeProblemCode() {
    if (this.#equals === 0) return P_MISSING_EQUALS;
    const last = this.#last;
    if (last === NO_FACE || this.#table.isMark[last] === 1) return P_TRAILING_OPERATOR;
    const value2 = this.#openValue();
    if (value2 === null) return P_MALFORMED_SIDE;
    return equals(value2, this.#sideValues[0]) ? NO_PROBLEM : P_UNBALANCED;
  }
  /**
   * The one face that, placed on the end of this line, would finish it as a
   * legal equation — `CLOSES_NOTHING` when no tile can, `CLOSES_ANYTHING` when
   * the question cannot be narrowed and the caller must not filter.
   *
   * This is `closeProblem` asked in reverse, and it is where the search stops
   * being a generate-and-test. A line that ends here must end on a NUMBER, and
   * that number is determined by the side it completes — so instead of trying
   * every face the cell admits and closing each one, the search works out the
   * single face that could work and tries only that.
   *
   * Assumes the line would END at the face: callers must not use it where board
   * tiles follow the cell. Over-generous answers are safe — `closeProblem` and
   * the validator still see everything this admits. Only a wrongly narrow one
   * could lose a move, which is why every uncertain case answers ANYTHING.
   */
  closingFaceId() {
    if (this.#equals === 0) return CLOSES_NOTHING;
    if (!this.#trusted) return CLOSES_ANYTHING;
    const side = this.#side;
    if (side.tens !== null) return CLOSES_NOTHING;
    if (side.digitCount >= MAX_DIGITS) return CLOSES_NOTHING;
    const want = requiredFinalNumber(side, this.#sideValues[0]);
    if (want === REQUIRED_NONE) return CLOSES_NOTHING;
    if (want === REQUIRED_ANY) return CLOSES_ANYTHING;
    if (want > 999) return CLOSES_NOTHING;
    if (side.digitCount > 0) {
      const block = POWERS_OF_TEN[side.digitCount];
      if (want < block || want >= block * 10) return CLOSES_NOTHING;
      if ((want - want % 10) / 10 !== side.digitValue) return CLOSES_NOTHING;
      return this.#table.numberFace[want % 10];
    }
    if (want > 20) return CLOSES_NOTHING;
    return this.#table.numberFace[want];
  }
  /** Put a face on the end, keeping the two cached readings of it in step. */
  #push(id) {
    this.#ids.push(id);
    this.#last = id;
    this.#adjacencyRow = id * this.#table.count;
  }
  /** A reusable undo record, snapshotting the state before the next push. */
  #record() {
    let undo = this.#undo[this.#depth];
    if (undo === void 0) {
      undo = blankUndo();
      this.#undo[this.#depth] = undo;
    }
    this.#depth += 1;
    undo.digitRun = this.#digitRun;
    undo.digitBlockFirst = this.#digitBlockFirst;
    undo.sideStart = this.#sideStart;
    undo.pushedValue = false;
    undo.trusted = this.#trusted;
    const side = this.#side;
    undo.dead = side.dead;
    undo.count = side.count;
    undo.sum = side.sum;
    undo.sumOp = side.sumOp;
    undo.term = side.term;
    undo.termOp = side.termOp;
    undo.digitCount = side.digitCount;
    undo.digitValue = side.digitValue;
    undo.digitBig = side.digitBig;
    undo.tens = side.tens;
    undo.negate = side.negate;
    return undo;
  }
  /**
   * The value of the side still being built.
   *
   * Read off the running evaluator when the line was built through `push`, and
   * from the parser when `strict` mode has put an unchecked face on it. Both
   * answer the same question; only the cost differs.
   */
  #openValue() {
    if (!this.#trusted) return evaluateSide(this.faces().slice(this.#sideStart));
    return sideValue(this.#side);
  }
  /**
   * Everything a face has to satisfy that does not need the side's value: the
   * pair it makes with the one before it, and the shape of the number it is
   * part of. The `=` balance check lives in `push`, where the value it needs is
   * worked out once and then kept.
   */
  #checkShape(id) {
    const table = this.#table;
    const previous = this.#last;
    const category = table.category[id];
    if (previous === NO_FACE) {
      if (category === CAT_MARK && table.mark[id] !== MARK_MINUS) return P_LEADING_OPERATOR;
    } else {
      const code = table.adjacent[this.#adjacencyRow + id];
      if (code !== ADJ_OK) return ADJACENCY_PROBLEM[code - 1];
    }
    if (category === CAT_UNIT) {
      if (this.#digitRun + 1 > MAX_DIGITS) return P_MAX_3_DIGITS;
      const first = this.#digitRun === 0 ? id : this.#digitBlockFirst;
      if (table.digit[first] === 0 && this.#digitRun + 1 >= 2) return P_LEADING_ZERO;
      if (table.digit[id] === 0 && previous !== NO_FACE && table.mark[previous] === MARK_MINUS) {
        const before = this.#ids[this.#ids.length - 2];
        if (before === void 0 || table.equals[before] === 1) return P_NEGATIVE_ZERO;
      }
    }
    return NO_PROBLEM;
  }
};

// ../amath-bot-lab/src/move-generator/pathSearch.ts
var SAMPLE_LIMIT = 24;
function emptyCounters() {
  return {
    nodes: 0,
    prefixesGenerated: 0,
    expansions: 0,
    rackBranches: 0,
    prunedByCandidates: 0,
    prunedByRouting: 0,
    prunedByPrefix: 0,
    prunedByGrammar: 0,
    prunedByArithmetic: 0,
    prefixReasons: new Int32Array(PROBLEM_COUNT),
    prunedByNoEquals: 0,
    prunedBySpan: 0,
    prunedByClosing: 0,
    closeChecksSaved: 0,
    closingSolves: 0,
    blankBranches: 0,
    choiceBranches: 0,
    samples: [],
    validatorCalls: 0,
    skippedByConnectivity: 0,
    skippedByLine: 0,
    prunedByCompletion: 0,
    lineReasons: new Int32Array(PROBLEM_COUNT),
    duplicatesSeen: 0,
    maxDepth: 0,
    longestEquation: 0,
    mostEquals: 0,
    movesByNewTiles: Array.from({ length: 9 }, () => 0),
    rejected: /* @__PURE__ */ new Map()
  };
}
var AXIS_SLOT = { vertical: 0, horizontal: 1 };
function boardFacts(board, map, table, spans) {
  const routable_ = new Uint8Array(CELL_COUNT * 2);
  const touches = new Uint8Array(CELL_COUNT);
  const faceId = new Int16Array(CELL_COUNT).fill(NO_FACE);
  const next = new Int16Array(CELL_COUNT * 2);
  const filled = new Uint8Array(CELL_COUNT);
  const spanTokensAhead = new Uint8Array(CELL_COUNT * 2);
  const spanFreeAhead = new Uint8Array(CELL_COUNT * 2);
  const spanEqualsCost = new Uint8Array(CELL_COUNT * 2);
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    routable_[cell * 2] = routable(map, cell, "vertical") ? 1 : 0;
    routable_[cell * 2 + 1] = routable(map, cell, "horizontal") ? 1 : 0;
    spanTokensAhead[cell * 2] = spans.tokensAhead(cell, "vertical");
    spanTokensAhead[cell * 2 + 1] = spans.tokensAhead(cell, "horizontal");
    spanFreeAhead[cell * 2] = spans.freeTokensAhead(cell, "vertical");
    spanFreeAhead[cell * 2 + 1] = spans.freeTokensAhead(cell, "horizontal");
    spanEqualsCost[cell * 2] = spans.equalsCost(cell, "vertical");
    spanEqualsCost[cell * 2 + 1] = spans.equalsCost(cell, "horizontal");
    touches[cell] = touchesBoard(board, cell) ? 1 : 0;
    next[cell * 2] = nextCell(cell, "vertical");
    next[cell * 2 + 1] = nextCell(cell, "horizontal");
    const tile = board[cell];
    if (tile) {
      faceId[cell] = table.idOf(tile.face);
      filled[cell] = 1;
    }
  }
  return {
    routable: routable_,
    touches,
    faceId,
    next,
    filled,
    spanTokensAhead,
    spanFreeAhead,
    spanEqualsCost
  };
}
function blankFrame() {
  return { cell: 0, kind: "0", face: "" };
}
function searchFrom(context, start, axis, onlyOption) {
  const board = context.position.board;
  const counters = context.counters;
  const rack = context.rack;
  const facts = context.facts;
  const gate = context.gate;
  const held = rack.counts;
  const table = faceTableFor(context.position.rules);
  const adjacent = table.adjacent;
  const axisSlot = AXIS_SLOT[axis];
  const frames = [];
  let depth = 0;
  const bridged = [];
  const empty = isBoardEmpty(board);
  const equalsAt = rack.indexOf("=");
  const blankAt = rack.indexOf("?");
  let touching = 0;
  let coversCentre = false;
  const tracing = context.trace !== null && context.trace.cell === start && context.trace.axis === axis;
  const prefix = seedPrefix(context, start, axis);
  if (prefix === null) {
    if (tracing) {
      record(context, {
        depth: 0,
        cell: start,
        axis,
        kind: "prune",
        face: null,
        tile: null,
        line: "",
        reason: "HEAD_NOT_AN_EQUATION",
        rackLeft: heldKinds(context),
        equalsCount: 0,
        openValue: null,
        closedValues: [],
        placedCells: [],
        bridgedCells: [],
        newTilesUsed: 0,
        budgetLeft: context.maxPlacements,
        spanAhead: context.spans.tokensAhead(start, axis),
        capacityAhead: emptyAhead(context, start, axis),
        windowLength: 0,
        closingFace: "",
        candidateFaces: [],
        detail: "the tiles already in front of this cell do not read as an equation"
      });
    }
    return 0;
  }
  let firstOptionCount2 = 0;
  let traceSpanAhead = 0;
  let traceCapacity = 0;
  let traceClosing = "*";
  let traceCandidates = [];
  const trace = (cell, kind, face, tile, reason, detail = null) => {
    if (!tracing) return;
    record(context, {
      depth,
      cell,
      axis,
      kind,
      face,
      tile,
      line: prefix.faces().join(" "),
      reason,
      rackLeft: heldKinds(context),
      equalsCount: prefix.equalsCount,
      openValue: formatValue(prefix.openSideValue()),
      closedValues: prefix.sideValues().map(formatShort),
      placedCells: frames.slice(0, depth).map((frame) => frame.cell),
      bridgedCells: [...bridged],
      newTilesUsed: depth,
      budgetLeft: Math.min(context.maxPlacements - depth, context.rack.remaining),
      spanAhead: traceSpanAhead,
      capacityAhead: traceCapacity,
      windowLength: depth === 0 ? 0 : cell - start === 0 ? 1 : distanceAlong(start, cell, axis),
      closingFace: traceClosing,
      candidateFaces: traceCandidates,
      detail
    });
  };
  const place = (at, cell, option) => {
    let frame = frames[at];
    if (frame === void 0) {
      frame = blankFrame();
      frames[at] = frame;
    }
    frame.cell = cell;
    frame.kind = option.kind;
    frame.face = option.face;
  };
  const notePrefixProblem = (problem, cell, option) => {
    counters.prunedByPrefix += 1;
    if (PROBLEM_KIND_CODE[problem] === KIND_ARITHMETIC) counters.prunedByArithmetic += 1;
    else counters.prunedByGrammar += 1;
    const reasons = counters.prefixReasons;
    reasons[problem] = reasons[problem] + 1;
    if (counters.samples.length < SAMPLE_LIMIT) {
      counters.samples.push({
        cell,
        line: prefix.faces().join(" "),
        face: option.face,
        kind: option.kind,
        reason: problemName(problem),
        rackLeft: heldKinds(context)
      });
    }
  };
  const step = (cell, span) => {
    if (span > context.maxSpan) return;
    if (cell < 0) return;
    counters.nodes += 1;
    if (facts.filled[cell] === 1) {
      const problem = prefix.pushId(facts.faceId[cell]);
      if (problem !== NO_PROBLEM) {
        if (tracing) trace(cell, "prune", board[cell].face, null, problemName(problem));
        return;
      }
      bridged.push(cell);
      if (tracing) trace(cell, "bridge", board[cell].face, null, null);
      step(facts.next[cell * 2 + axisSlot], span + 1);
      bridged.pop();
      prefix.pop();
      return;
    }
    if (!context.strict && !context.ignoreSpans) {
      const budgetLeft = context.maxPlacements - depth;
      const rackCanEqual = equalsAt >= 0 && held[equalsAt] > 0 || blankAt >= 0 && held[blankAt] > 0;
      if (!prefix.hasEquals && !rackCanEqual) {
        const cost = facts.spanEqualsCost[cell * 2 + axisSlot];
        if (cost > budgetLeft) {
          counters.prunedByNoEquals += 1;
          if (tracing) {
            trace(
              cell,
              "prune",
              null,
              null,
              "NO_EQUALS_IN_REACH",
              `an = on the board is ${cost} tiles away, ${budgetLeft} left`
            );
          }
          return;
        }
      }
      const needed = tokensStillNeeded(prefix);
      if (needed > 0) {
        const reach = budgetLeft > 0 ? facts.spanTokensAhead[cell * 2 + axisSlot] : facts.spanFreeAhead[cell * 2 + axisSlot];
        if (needed > reach) {
          counters.prunedBySpan += 1;
          if (tracing) {
            traceSpanAhead = reach;
            trace(
              cell,
              "prune",
              null,
              null,
              "CUT_CAPACITY",
              `needs ${needed} more token(s), the continuous span has ${reach}`
            );
          }
          return;
        }
      }
    }
    if (!context.ignoreSpaceMap && facts.routable[cell * 2 + axisSlot] === 0) {
      counters.prunedByRouting += 1;
      if (tracing) trace(cell, "prune", null, null, "NOT_ROUTABLE");
      return;
    }
    const groups = gate.optionsAtSlot(cell * 2 + axisSlot);
    const atStart = depth === 0;
    const adjacencyRow = prefix.adjacencyRow;
    let index = 0;
    const ahead = facts.next[cell * 2 + axisSlot];
    const canContinue = rack.remaining > 1 && depth + 1 < context.maxPlacements && span < context.maxSpan && ahead >= 0;
    const tailFollows = ahead >= 0 && facts.filled[ahead] === 1;
    let closing = CLOSES_ANYTHING;
    if (!context.strict && !context.ignoreClosing && !tailFollows) {
      closing = prefix.closingFaceId();
      counters.closingSolves += 1;
    }
    if (tracing) {
      traceSpanAhead = context.spans.tokensAhead(cell, axis);
      traceCapacity = emptyAhead(context, cell, axis);
      traceClosing = closing === CLOSES_ANYTHING ? "*" : closing < 0 ? "" : prefix.table.faces[closing] ?? "";
      traceCandidates = gate.optionsAt(cell, axis).filter((group) => rack.hasAt(group.kindAt)).flatMap((group) => group.faces.map((option) => option.face));
      trace(cell, "node", null, null, null, tailFollows ? "a board tile follows this cell" : null);
    }
    if (!canContinue && !atStart && !tracing && closing !== CLOSES_ANYTHING) {
      let offered = 0;
      for (let g = 0; g < groups.length; g += 1) {
        const group = groups[g];
        if (held[group.kindAt] === 0) continue;
        counters.prunedByCandidates += group.pruned;
        if (group.faces.length === 0) continue;
        counters.rackBranches += 1;
        offered += group.faces.length;
      }
      if (closing !== CLOSES_NOTHING) {
        const wearers = gate.optionsForFace(cell, axis, closing);
        for (let w = 0; w < wearers.length; w += 1) {
          const option = wearers[w];
          if (held[option.kindAt] === 0) continue;
          offered -= 1;
          if (option.branch === BRANCH_BLANK) counters.blankBranches += 1;
          else if (option.branch === BRANCH_CHOICE) counters.choiceBranches += 1;
          const code = adjacencyRow < 0 ? ADJ_OK : adjacent[adjacencyRow + option.faceId];
          const problem = code === ADJ_OK ? prefix.pushId(option.faceId) : ADJACENCY_PROBLEM[code - 1];
          if (problem !== NO_PROBLEM) {
            notePrefixProblem(problem, cell, option);
            continue;
          }
          counters.expansions += 1;
          counters.prefixesGenerated += 1;
          rack.takeAt(option.kindAt);
          const touches = facts.touches[cell] === 1;
          place(depth, cell, option);
          depth += 1;
          if (touches) touching += 1;
          const centreBefore = coversCentre;
          if (cell === CENTER_INDEX) coversCentre = true;
          if (depth > counters.maxDepth) counters.maxDepth = depth;
          consider(
            context,
            frames,
            depth,
            axis,
            start,
            span,
            empty,
            touching,
            coversCentre,
            prefix,
            trace
          );
          if (touches) touching -= 1;
          coversCentre = centreBefore;
          depth -= 1;
          rack.giveAt(option.kindAt);
          prefix.pop();
        }
      }
      counters.prunedByClosing += offered;
      return;
    }
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[g];
      if (held[group.kindAt] === 0) continue;
      counters.prunedByCandidates += group.pruned;
      const faces = group.faces;
      if (faces.length === 0) continue;
      counters.rackBranches += 1;
      if (atStart) firstOptionCount2 += faces.length;
      for (let f = 0; f < faces.length; f += 1) {
        const optionIndex = index;
        index += 1;
        if (atStart && onlyOption !== void 0 && optionIndex !== onlyOption) continue;
        const option = faces[f];
        const closes = closing === CLOSES_ANYTHING || closing === option.faceId;
        if (!closes && !canContinue) {
          counters.prunedByClosing += 1;
          if (tracing) trace(cell, "prune", option.face, option.kind, "CANNOT_CLOSE_OR_CONTINUE");
          continue;
        }
        if (option.branch === BRANCH_BLANK) counters.blankBranches += 1;
        else if (option.branch === BRANCH_CHOICE) counters.choiceBranches += 1;
        const code = adjacencyRow < 0 ? ADJ_OK : adjacent[adjacencyRow + option.faceId];
        const problem = code === ADJ_OK ? prefix.pushId(option.faceId) : ADJACENCY_PROBLEM[code - 1];
        if (problem !== NO_PROBLEM) {
          notePrefixProblem(problem, cell, option);
          if (tracing) trace(cell, "prune", option.face, option.kind, problemName(problem));
          if (!context.strict) continue;
          prefix.pushUncheckedId(option.faceId);
        }
        counters.expansions += 1;
        counters.prefixesGenerated += 1;
        rack.takeAt(option.kindAt);
        const touches = facts.touches[cell] === 1;
        place(depth, cell, option);
        depth += 1;
        if (touches) touching += 1;
        const centreBefore = coversCentre;
        if (cell === CENTER_INDEX) coversCentre = true;
        if (depth > counters.maxDepth) counters.maxDepth = depth;
        if (tracing) trace(cell, "place", option.face, option.kind, null);
        if (closes) {
          consider(
            context,
            frames,
            depth,
            axis,
            start,
            span,
            empty,
            touching,
            coversCentre,
            prefix,
            trace
          );
        } else {
          counters.closeChecksSaved += 1;
        }
        if (rack.remaining > 0 && depth < context.maxPlacements) {
          step(ahead, span + 1);
        }
        if (touches) touching -= 1;
        coversCentre = centreBefore;
        depth -= 1;
        rack.giveAt(option.kindAt);
        prefix.pop();
      }
    }
  };
  step(start, 1);
  return firstOptionCount2;
}
function record(context, event) {
  const sink = context.trace;
  if (sink === null || sink.events.length >= sink.limit) return;
  sink.events.push(event);
}
function distanceAlong(from, to, axis) {
  return axis === "horizontal" ? colOf(to) - colOf(from) + 1 : rowOf(to) - rowOf(from) + 1;
}
function emptyAhead(context, cell, axis) {
  const span = context.spans.at(cell, axis);
  if (span === null) return 0;
  let count = 0;
  let seen = false;
  for (const at of span.cells) {
    if (at === cell) seen = true;
    if (seen && !context.position.board[at]) count += 1;
  }
  return count;
}
function heldKinds(context) {
  return [...context.rack.kinds].filter((kind) => context.rack.has(kind));
}
function formatValue(value2) {
  return value2 === null ? null : formatShort(value2);
}
function tokensStillNeeded(prefix) {
  if (!prefix.hasEquals) return 2;
  const last = prefix.lastFaceId;
  return last !== NO_FACE && prefix.table.equals[last] === 1 ? 1 : 0;
}
function consider(context, frames, depth, axis, origin, span, boardEmpty, touching, coversCentre, prefix, trace) {
  const last = frames[depth - 1];
  if (!context.strict) {
    const connected = boardEmpty ? coversCentre : touching > 0;
    if (!connected) {
      context.counters.skippedByConnectivity += 1;
      return;
    }
  }
  if (!context.strict) {
    let pushed = 0;
    let problem = NO_PROBLEM;
    for (let at = nextCell(last.cell, axis); at >= 0 && context.position.board[at]; at = nextCell(at, axis)) {
      problem = prefix.pushId(context.facts.faceId[at]);
      if (problem !== NO_PROBLEM) break;
      pushed += 1;
    }
    if (problem === NO_PROBLEM) problem = prefix.closeProblemCode();
    for (let i = 0; i < pushed; i += 1) prefix.pop();
    if (problem !== NO_PROBLEM) {
      context.counters.skippedByLine += 1;
      if (PROBLEM_KIND_CODE[problem] === KIND_COMPLETION) context.counters.prunedByCompletion += 1;
      const reasons = context.counters.lineReasons;
      reasons[problem] = reasons[problem] + 1;
      trace(last.cell, "prune", null, null, `CLOSE:${problemName(problem)}`);
      return;
    }
  }
  const kinds = new Array(depth);
  for (let at = 0; at < depth; at += 1) kinds[at] = frames[at].kind;
  const ids = context.rack.idsFor(kinds);
  const placements = new Array(depth);
  for (let at = 0; at < depth; at += 1) {
    const frame = frames[at];
    placements[at] = { cell: frame.cell, tileId: ids[at], kind: frame.kind, face: frame.face };
  }
  context.counters.validatorCalls += 1;
  trace(last.cell, "validate", null, null, null);
  const result = validatePlacement(context.position.board, placements, context.position.rules);
  if (!result.legal) {
    for (const item of result.diagnostics) {
      context.counters.rejected.set(item.code, (context.counters.rejected.get(item.code) ?? 0) + 1);
    }
    trace(last.cell, "prune", null, null, `VALIDATOR:${result.diagnostics[0]?.code ?? "?"}`);
    return;
  }
  const breakdown = context.score ? scorePlacement(context.position.board, placements, result.runs, context.position.rules) : null;
  const placedCells = new Set(placements.map((placement) => placement.cell));
  const runs = result.runs.map(
    (run2, index) => summariseRun(run2, placedCells, breakdown?.equations[index])
  );
  const mainRun = runs.find((run2) => run2.axis === axis) ?? null;
  const primary = mainRun ?? runs.reduce((best, run2) => pickLonger(best, run2), null);
  const reused = /* @__PURE__ */ new Set();
  for (const run2 of runs) for (const cell of run2.reused) reused.add(cell);
  const newCells = placements.map((placement) => placement.cell).sort((a, b) => a - b);
  const equationLength = primary?.cells.length ?? 0;
  const equalsCount = primary?.equalsCount ?? 0;
  const added = context.collector.add({
    move: { type: "place", placements },
    placements,
    axis,
    origin,
    modes: modesUsed(context.map, frames, depth, axis),
    span,
    newTileCount: placements.length,
    newCells,
    reusedCells: [...reused].sort((a, b) => a - b),
    equationLength,
    equalsCount,
    tileIds: placements.map((placement) => placement.tileId),
    kinds,
    mainRun,
    crossRuns: runs.filter((run2) => run2 !== mainRun),
    score: breakdown?.total ?? 0,
    bingo: breakdown?.bingoBonus ?? 0,
    scoreBreakdown: breakdown
  });
  if (!added) {
    context.counters.duplicatesSeen += 1;
    return;
  }
  const counters = context.counters;
  const bucket = Math.min(8, placements.length);
  counters.movesByNewTiles[bucket] = (counters.movesByNewTiles[bucket] ?? 0) + 1;
  if (equationLength > counters.longestEquation) counters.longestEquation = equationLength;
  if (equalsCount > counters.mostEquals) counters.mostEquals = equalsCount;
  trace(last.cell, "legal", null, null, breakdown === null ? null : `score ${breakdown.total}`);
}
function pickLonger(best, run2) {
  if (best === null) return run2;
  return run2.cells.length > best.cells.length ? run2 : best;
}
function summariseRun(run2, placed, score) {
  return {
    axis: run2.direction,
    cells: run2.cells,
    text: run2.text,
    placed: run2.cells.filter((cell) => placed.has(cell)),
    reused: run2.cells.filter((cell) => !placed.has(cell)),
    equalsCount: run2.tokens.filter((token) => isEqualsFace(token.face)).length,
    subtotal: score?.subtotal ?? 0,
    multiplier: score?.multiplier ?? 1
  };
}
function modesUsed(map, frames, depth, axis) {
  const directions = axis === "vertical" ? ["up", "down"] : ["left", "right"];
  const modes = /* @__PURE__ */ new Set();
  for (let at = 0; at < depth; at += 1) {
    const frame = frames[at];
    const mask = map.directionsAt(frame.cell);
    for (const direction of directions) {
      for (const mode of mask.modesOf(direction)) modes.add(mode);
    }
  }
  return [...modes].sort();
}
function touchesBoard(board, cell) {
  const row = rowOf(cell);
  const col = colOf(cell);
  if (row > 0 && board[cellAt(row - 1, col)]) return true;
  if (row < BOARD_SIZE - 1 && board[cellAt(row + 1, col)]) return true;
  if (col > 0 && board[cellAt(row, col - 1)]) return true;
  if (col < BOARD_SIZE - 1 && board[cellAt(row, col + 1)]) return true;
  return false;
}
function seedPrefix(context, start, axis) {
  const board = context.position.board;
  const prefix = new PrefixState(context.position.rules);
  const head = [];
  for (let at = previousCell(start, axis); at >= 0 && board[at]; at = previousCell(at, axis)) {
    head.unshift(board[at].face);
  }
  for (const face of head) {
    if (prefix.push(face) !== null) return null;
  }
  return prefix;
}
function firstOptionCount(context, start, axis) {
  if (!context.ignoreSpaceMap && context.facts.routable[start * 2 + AXIS_SLOT[axis]] === 0) {
    return 0;
  }
  if (seedPrefix(context, start, axis) === null) return 0;
  return expandCell(context.gate, start, axis, context.rack).options.length;
}
function previousCell(cell, axis) {
  const row = rowOf(cell);
  const col = colOf(cell);
  if (axis === "horizontal") return col > 0 ? cellAt(row, col - 1) : -1;
  return row > 0 ? cellAt(row - 1, col) : -1;
}
function nextCell(cell, axis) {
  const row = rowOf(cell);
  const col = colOf(cell);
  if (axis === "horizontal") return col + 1 < BOARD_SIZE ? cellAt(row, col + 1) : -1;
  return row + 1 < BOARD_SIZE ? cellAt(row + 1, col) : -1;
}

// ../amath-bot-lab/src/move-generator/generateMoves.ts
var AXES = ["horizontal", "vertical"];
var DEFAULT_TRACE_LIMIT = 4e3;
function resolveMaxNewTiles(options, rackSize) {
  const requested = options.maxNewTiles ?? options.maxPlacements ?? rackSize;
  return Math.max(0, Math.min(Math.floor(requested), rackSize));
}
function prepareSearch(position, options = {}) {
  const rack = new RackState(position.rack);
  const maxNewTiles = resolveMaxNewTiles(options, rack.remaining);
  const map = reuseOrBuildMap(position, options, maxNewTiles);
  const spans = reuseOrBuildSpans(options, map, position);
  const collector = new MoveCollector();
  const counters = emptyCounters();
  const trace = options.trace === void 0 ? null : {
    cell: options.trace.cell,
    axis: options.trace.axis,
    limit: Math.max(1, options.traceLimit ?? DEFAULT_TRACE_LIMIT),
    events: []
  };
  const table = faceTableFor(position.rules);
  const context = {
    position,
    spans,
    map,
    gate: new FaceGate(map, table, rack.kinds, options.ignoreSpaceMap ?? false),
    facts: boardFacts(position.board, map, table, spans),
    rack,
    collector,
    counters,
    maxSpan: options.maxSpan ?? BOARD_SIZE,
    maxPlacements: maxNewTiles,
    score: options.score ?? true,
    strict: options.strict ?? false,
    ignoreSpaceMap: options.ignoreSpaceMap ?? false,
    ignoreSpans: options.ignoreSpans ?? false,
    ignoreClosing: options.ignoreClosing ?? false,
    trace
  };
  const units = [];
  const touchedSpans = /* @__PURE__ */ new Set();
  let startCells = 0;
  let startCellsSkipped = 0;
  if (maxNewTiles > 0) {
    for (const axis of AXES) {
      if (options.only !== void 0 && options.only.axis !== axis) continue;
      for (let cell = 0; cell < CELL_COUNT; cell += 1) {
        if (position.board[cell]) continue;
        if (options.only !== void 0 && options.only.cell !== cell) continue;
        if (!context.ignoreSpaceMap && !routable(map, cell, axis)) {
          startCellsSkipped += 1;
          continue;
        }
        startCells += 1;
        const span = spans.at(cell, axis);
        if (span !== null) touchedSpans.add(span);
        const count = firstOptionCount(context, cell, axis);
        for (let option = 0; option < count; option += 1) units.push({ axis, cell, option });
      }
    }
  }
  return {
    context,
    collector,
    counters,
    map,
    spans,
    units,
    startCells,
    startCellsSkipped,
    spansSearched: touchedSpans.size,
    spansTotal: spans.spans("vertical").length + spans.spans("horizontal").length,
    trace
  };
}
function reuseOrBuildMap(position, options, maxNewTiles) {
  const supplied = options.spaceMap;
  if (supplied !== void 0) {
    const version = boardVersionOf(position.board);
    if (supplied.boardVersion !== version) {
      throw new Error(
        `space map describes a different board (${supplied.boardVersion} vs ${version})`
      );
    }
    if (supplied.params().maxNewTiles < Math.max(1, maxNewTiles)) {
      throw new Error(
        `space map was propagated to ${supplied.params().maxNewTiles} tiles, which is short of the ${maxNewTiles} this search may place`
      );
    }
    if (supplied.params().ruleSetId !== position.rules.id) {
      throw new Error(`space map was built under rules ${supplied.params().ruleSetId}`);
    }
    return supplied;
  }
  return buildSpaceMap(position, { maxNewTiles: Math.max(1, maxNewTiles) });
}
function reuseOrBuildSpans(options, map, position) {
  return options.spans ?? buildSpanIndex(map, position.board);
}
function runUnit(prepared, unit) {
  searchFrom(prepared.context, unit.cell, unit.axis, unit.option);
}
function finishSearch(prepared, startedAt, unitsDone) {
  const counters = prepared.counters;
  const stats = {
    startCells: prepared.startCells,
    startCellsSkipped: prepared.startCellsSkipped,
    spansSearched: prepared.spansSearched,
    spansTotal: prepared.spansTotal,
    nodes: counters.nodes,
    prefixesGenerated: counters.prefixesGenerated,
    expansions: counters.expansions,
    rackBranches: counters.rackBranches,
    blankBranches: counters.blankBranches,
    choiceBranches: counters.choiceBranches,
    prunedByCandidates: counters.prunedByCandidates,
    prunedByRouting: counters.prunedByRouting,
    prunedByPrefix: counters.prunedByPrefix,
    prunedByGrammar: counters.prunedByGrammar,
    prunedByArithmetic: counters.prunedByArithmetic,
    prunedByNoEquals: counters.prunedByNoEquals,
    prunedBySpan: counters.prunedBySpan,
    prunedByClosing: counters.prunedByClosing,
    closeChecksSaved: counters.closeChecksSaved,
    closingSolves: counters.closingSolves,
    prefixSamples: counters.samples,
    prefixReasons: namedReasons(counters.prefixReasons),
    validatorCalls: counters.validatorCalls,
    skippedByConnectivity: counters.skippedByConnectivity,
    skippedByLine: counters.skippedByLine,
    prunedByCompletion: counters.prunedByCompletion,
    lineReasons: namedReasons(counters.lineReasons),
    rejectedByCode: [...counters.rejected.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    legalMoves: prepared.collector.size,
    duplicates: prepared.collector.duplicates,
    movesByNewTiles: counters.movesByNewTiles,
    longestEquation: counters.longestEquation,
    mostEquals: counters.mostEquals,
    maxDepth: counters.maxDepth,
    spaceMapTruncated: prepared.map.stats().truncated,
    maxNewTiles: prepared.context.maxPlacements,
    maxSpan: prepared.context.maxSpan,
    scored: prepared.context.score,
    elapsedMs: performance.now() - startedAt,
    unitsTotal: prepared.units.length,
    unitsDone
  };
  const trace = prepared.trace?.events ?? [];
  return {
    moves: prepared.collector.moves(),
    stats,
    spaceMap: prepared.map,
    spans: prepared.spans,
    trace
  };
}
function generateMoves(position, options = {}) {
  const started = performance.now();
  const prepared = prepareSearch(position, options);
  for (const unit of prepared.units) runUnit(prepared, unit);
  return finishSearch(prepared, started, prepared.units.length);
}
function namedReasons(counts) {
  const rows = [];
  for (let code = 0; code < counts.length; code += 1) {
    const count = counts[code];
    if (count > 0) rows.push({ reason: problemName(code), count });
  }
  return rows.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

// ../amath-bot-lab/src/core/types.ts
function otherSide(side) {
  return side === "A" ? "B" : "A";
}

// ../amath-bot-lab/src/env/exchange.ts
function groupByKind(manifest, rack) {
  const order = [];
  const byKind = /* @__PURE__ */ new Map();
  for (const id of rack) {
    const kind = tileKind(manifest, id);
    const held = byKind.get(kind);
    if (held) held.push(id);
    else {
      byKind.set(kind, [id]);
      order.push(kind);
    }
  }
  return order.map((kind) => ({ kind, ids: byKind.get(kind) }));
}
function enumerateExchangeSubsets(manifest, rack) {
  const groups = groupByKind(manifest, rack);
  const out = [];
  const taken = new Array(groups.length).fill(0);
  const emit = () => {
    const tileIds = [];
    const kinds = [];
    for (let g = 0; g < groups.length; g += 1) {
      const group = groups[g];
      for (let i = 0; i < taken[g]; i += 1) {
        tileIds.push(group.ids[i]);
        kinds.push(group.kind);
      }
    }
    if (tileIds.length > 0) out.push({ tileIds, kinds });
  };
  const walk = (index) => {
    if (index === groups.length) {
      emit();
      return;
    }
    const copies = groups[index].ids.length;
    for (let count = 0; count <= copies; count += 1) {
      taken[index] = count;
      walk(index + 1);
    }
    taken[index] = 0;
  };
  walk(0);
  return out;
}
function exchangeAllowed(state) {
  return isExchangeAllowed(
    state.bag.length,
    state.racks[otherSide(state.activeSide)].length,
    state.rules
  );
}
function enumerateExchangeActions(state) {
  if (state.terminal) return [];
  if (!exchangeAllowed(state)) return [];
  const rack = state.racks[state.activeSide];
  return enumerateExchangeSubsets(state.manifest, rack).map((subset) => {
    const action = {
      type: "exchange",
      tileIds: subset.tileIds,
      kinds: subset.kinds
    };
    return { id: moveId(action), action, score: 0 };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

// ../amath-bot-lab/src/env/state.ts
function envStateFrom(parts) {
  const state = {
    manifest: parts.manifest ?? createManifest(),
    rules: BOT_RULES,
    seed: parts.seed ?? 1,
    board: parts.board ?? EMPTY_BOARD,
    racks: parts.racks,
    pendingReturn: parts.pendingReturn ?? { A: [], B: [] },
    bag: parts.bag,
    scores: parts.scores ?? { A: 0, B: 0 },
    activeSide: parts.activeSide ?? "A",
    turnNumber: parts.turnNumber ?? 1,
    noScoreTail: parts.noScoreTail ?? [],
    hasPlacement: parts.hasPlacement ?? false,
    rngStep: parts.rngStep ?? 0,
    terminal: null
  };
  assertTileConservation(state);
  return state;
}
function assertTileConservation(state) {
  const seen = /* @__PURE__ */ new Map();
  const claim = (id, where) => {
    const previous = seen.get(id);
    if (previous) throw new Error(`tile conservation: ${id} is in both ${previous} and ${where}`);
    if (!state.manifest.kindOf.has(id)) throw new Error(`tile conservation: unknown tile ${id}`);
    seen.set(id, where);
  };
  state.board.forEach((cell) => {
    if (cell) claim(cell.tileId, "board");
  });
  state.racks.A.forEach((id) => claim(id, "rack A"));
  state.racks.B.forEach((id) => claim(id, "rack B"));
  state.pendingReturn.A.forEach((id) => claim(id, "pendingReturn A"));
  state.pendingReturn.B.forEach((id) => claim(id, "pendingReturn B"));
  state.bag.forEach((id) => claim(id, "bag"));
  if (seen.size !== state.manifest.tiles.length) {
    const missing = state.manifest.tiles.filter((tile) => !seen.has(tile.id)).map((tile) => tile.id);
    throw new Error(
      `tile conservation: counted ${seen.size}/${state.manifest.tiles.length}, missing [${missing.join(", ")}]`
    );
  }
}
function assertDecisionInvariants(state) {
  if (state.pendingReturn.A.length > 0 || state.pendingReturn.B.length > 0) {
    throw new Error("decision invariant: a pendingReturn pile is not empty");
  }
  assertTileConservation(state);
}
function tilesOf(manifest, ids) {
  return ids.map((id) => ({ id, kind: tileKind(manifest, id) }));
}
function envPosition(state, side = state.activeSide) {
  const opponent = otherSide(side);
  const unseenIds = [...state.bag, ...state.racks[opponent], ...state.pendingReturn[opponent]];
  return {
    rules: state.rules,
    board: state.board,
    side,
    rack: tilesOf(state.manifest, state.racks[side]),
    opponentRackCount: state.racks[opponent].length,
    ownSetAside: tilesOf(state.manifest, state.pendingReturn[side]),
    opponentSetAsideCount: state.pendingReturn[opponent].length,
    poolCount: state.bag.length,
    unseen: kindCounts(state.manifest, unseenIds),
    scores: state.scores,
    noScoreStreak: state.noScoreTail.length,
    turnNumber: state.turnNumber
  };
}

// ../amath-bot-lab/src/env/actions.ts
var PASS_ACTION = { type: "pass" };
var PASS_ID = moveId(PASS_ACTION);
function isScorelessTurn(action) {
  return action.type === "exchange" || action.type === "pass";
}
function emptyStats(state) {
  return generateMoves({ ...envPosition(state), rack: [] }, {}).stats;
}
function enumerateActions(state) {
  if (state.terminal) {
    return {
      place: [],
      exchange: [],
      pass: null,
      generator: emptyStats(state),
      truncated: false,
      source: null
    };
  }
  const generated = generateMoves(envPosition(state), {});
  const place = generated.moves.map((found) => ({
    id: found.id,
    action: found.move,
    score: found.score
  }));
  return {
    place,
    exchange: enumerateExchangeActions(state),
    pass: { id: PASS_ID, action: PASS_ACTION, score: 0 },
    generator: generated.stats,
    truncated: generated.stats.spaceMapTruncated,
    // The search's own output, kept rather than dropped on the floor. `place`
    // above is a projection OF THESE MOVES — same array, same order — so this
    // is not a second enumeration and cannot disagree with the first. It exists
    // because a consumer that wants the cells and the runs used to have to run
    // the whole search a second time to get them back.
    source: { moves: generated.moves, spaceMap: generated.spaceMap, spans: generated.spans }
  };
}

// ../amath-bot-lab/src/areas/candidates.ts
function attributeMoves(moves, byCell, areaCount) {
  const originOf = new Int16Array(moves.length).fill(-1);
  const touching = Array.from({ length: areaCount }, () => []);
  const origins = Array.from({ length: areaCount }, () => []);
  let spanningAreas = 0;
  let unattributed = 0;
  for (let index = 0; index < moves.length; index += 1) {
    const move = moves[index];
    const areas = /* @__PURE__ */ new Set();
    let origin = -1;
    for (const cell of move.newCells) {
      const found = byCell[cell] ?? -1;
      if (found < 0) continue;
      areas.add(found);
      if (origin < 0) origin = found;
    }
    if (areas.size > 1) spanningAreas += 1;
    if (origin < 0) {
      unattributed += 1;
      continue;
    }
    originOf[index] = origin;
    origins[origin].push(index);
    for (const area of areas) touching[area].push(index);
  }
  return { originOf, touching, origins, spanningAreas, unattributed };
}
function summariseCandidates(moves, touching, origins, topCount) {
  if (touching.length === 0) {
    return {
      count: 0,
      originCount: origins.length,
      bestScore: 0,
      averageScore: 0,
      medianScore: 0,
      maxNewTiles: 0,
      topMoveIds: []
    };
  }
  const scores = [];
  let total = 0;
  let best = Number.NEGATIVE_INFINITY;
  let maxNewTiles = 0;
  for (const index of touching) {
    const move = moves[index];
    scores.push(move.score);
    total += move.score;
    if (move.score > best) best = move.score;
    if (move.newTileCount > maxNewTiles) maxNewTiles = move.newTileCount;
  }
  scores.sort((a, b) => a - b);
  const middle = Math.floor(scores.length / 2);
  const median = scores.length % 2 === 1 ? scores[middle] : (scores[middle - 1] + scores[middle]) / 2;
  const ranked = [...touching].sort((a, b) => {
    const gap = moves[b].score - moves[a].score;
    if (gap !== 0) return gap;
    return moves[a].id < moves[b].id ? -1 : moves[a].id > moves[b].id ? 1 : 0;
  });
  return {
    count: touching.length,
    originCount: origins.length,
    bestScore: best,
    averageScore: Math.round(total / touching.length * 100) / 100,
    medianScore: median,
    maxNewTiles,
    topMoveIds: ranked.slice(0, topCount).map((index) => moves[index].id)
  };
}

// ../amath-bot-lab/src/areas/partition.ts
function partitionAreas(map, spans, board) {
  const open = new Uint8Array(CELL_COUNT);
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (board[cell] === null && map.isReachable(cell)) open[cell] = 1;
  }
  const anchorCell = new Uint8Array(CELL_COUNT);
  const clusterOfAnchorId = /* @__PURE__ */ new Map();
  const anchorIdsByCell = /* @__PURE__ */ new Map();
  for (const anchor of map.anchors()) {
    anchorCell[anchor.cell] = 1;
    const ids = anchorIdsByCell.get(anchor.cell) ?? [];
    ids.push(anchor.id);
    anchorIdsByCell.set(anchor.cell, ids);
  }
  const find = makeUnionFind(CELL_COUNT);
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (anchorCell[cell] !== 1) continue;
    if (colOf(cell) + 1 < BOARD_SIZE && anchorCell[cell + 1] === 1) find.union(cell, cell + 1);
    if (rowOf(cell) + 1 < BOARD_SIZE && anchorCell[cell + BOARD_SIZE] === 1) {
      find.union(cell, cell + BOARD_SIZE);
    }
  }
  const clusterId = /* @__PURE__ */ new Map();
  const anchorCells = [];
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (anchorCell[cell] !== 1) continue;
    const root = find.of(cell);
    let id = clusterId.get(root);
    if (id === void 0) {
      id = anchorCells.length;
      clusterId.set(root, id);
      anchorCells.push([]);
    }
    anchorCells[id].push(cell);
    for (const anchorId2 of anchorIdsByCell.get(cell) ?? []) clusterOfAnchorId.set(anchorId2, id);
  }
  const bridged = /* @__PURE__ */ new Set();
  for (const axis of ["horizontal", "vertical"]) {
    for (let line2 = 0; line2 < BOARD_SIZE; line2 += 1) {
      let previous = -1;
      let occupiedSince = 0;
      for (let step = 0; step < BOARD_SIZE; step += 1) {
        const cell = axis === "horizontal" ? line2 * BOARD_SIZE + step : step * BOARD_SIZE + line2;
        if (board[cell] !== null) {
          occupiedSince += 1;
          continue;
        }
        if (anchorCell[cell] === 1) {
          if (previous >= 0 && occupiedSince > 0 && spans.sameSpan(previous, cell, axis)) {
            const a = clusterId.get(find.of(previous));
            const b = clusterId.get(find.of(cell));
            if (a !== b) bridged.add(a < b ? `${a}:${b}` : `${b}:${a}`);
          }
          previous = cell;
        } else if (open[cell] !== 1) {
          previous = -1;
        }
        occupiedSince = 0;
      }
    }
  }
  const byCell = new Int16Array(CELL_COUNT).fill(-1);
  const groups = anchorCells.map(() => []);
  const leftover = [];
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (open[cell] !== 1) continue;
    let bestCluster = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    let bestAnchor = "";
    for (const path of map.pathsTo(cell)) {
      const cluster = clusterOfAnchorId.get(path.anchorId);
      if (cluster === void 0) continue;
      if (path.cost < bestCost || path.cost === bestCost && (cluster < bestCluster || cluster === bestCluster && path.anchorId < bestAnchor)) {
        bestCost = path.cost;
        bestCluster = cluster;
        bestAnchor = path.anchorId;
      }
    }
    if (bestCluster < 0) {
      leftover.push(cell);
      continue;
    }
    byCell[cell] = bestCluster;
    groups[bestCluster].push(cell);
  }
  if (leftover.length > 0) {
    const isLeftover = new Uint8Array(CELL_COUNT);
    for (const cell of leftover) isLeftover[cell] = 1;
    const spare = makeUnionFind(CELL_COUNT);
    for (const cell of leftover) {
      if (colOf(cell) + 1 < BOARD_SIZE && isLeftover[cell + 1] === 1) spare.union(cell, cell + 1);
      if (rowOf(cell) + 1 < BOARD_SIZE && isLeftover[cell + BOARD_SIZE] === 1) {
        spare.union(cell, cell + BOARD_SIZE);
      }
    }
    const spareId = /* @__PURE__ */ new Map();
    for (const cell of leftover) {
      const root = spare.of(cell);
      let id = spareId.get(root);
      if (id === void 0) {
        id = groups.length;
        spareId.set(root, id);
        groups.push([]);
        anchorCells.push([]);
      }
      byCell[cell] = id;
      groups[id].push(cell);
    }
  }
  const keep = [];
  for (let id = 0; id < groups.length; id += 1) {
    if (groups[id].length > 0) keep.push(id);
  }
  if (keep.length !== groups.length) {
    const renumber = new Map(keep.map((old, index) => [old, index]));
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      const id = byCell[cell];
      if (id >= 0) byCell[cell] = renumber.get(id);
    }
    return {
      byCell,
      groups: keep.map((id) => groups[id]),
      anchorCells: keep.map((id) => anchorCells[id].sort((a, b) => a - b)),
      bridgedAreaPairs: bridged.size,
      unjustifiedCells: leftover.length
    };
  }
  return {
    byCell,
    groups,
    anchorCells: anchorCells.map((cells) => cells.sort((a, b) => a - b)),
    bridgedAreaPairs: bridged.size,
    unjustifiedCells: leftover.length
  };
}
function makeUnionFind(size) {
  const parent = new Int32Array(size);
  for (let index = 0; index < size; index += 1) parent[index] = index;
  const of = (cell) => {
    let root = cell;
    while (parent[root] !== root) root = parent[root];
    let walk = cell;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  return {
    of,
    union(a, b) {
      const rootA = of(a);
      const rootB = of(b);
      if (rootA === rootB) return false;
      if (rootA < rootB) parent[rootB] = rootA;
      else parent[rootA] = rootB;
      return true;
    }
  };
}

// ../amath-bot-lab/src/areas/features.ts
var AXES2 = ["horizontal", "vertical"];
function structureOf(id, cells, anchorCells, map, spans, board, inArea) {
  const modeCounts = { cross: 0, extend: 0, hook: 0, seed: 0 };
  const directionsSeen = /* @__PURE__ */ new Set();
  const axesSeen = /* @__PURE__ */ new Set();
  const spanIds = /* @__PURE__ */ new Set();
  const premium = {};
  const boardCells = /* @__PURE__ */ new Set();
  const frontier = /* @__PURE__ */ new Set();
  let openings = 0;
  let crossCells = 0;
  let constrainedCells = 0;
  let forcedCells = 0;
  let equalsReachableCells = 0;
  let pathCount = 0;
  let longestLine = 0;
  let largestCapacity = 0;
  let minCost = Number.POSITIVE_INFINITY;
  let focus = cells[0] ?? 0;
  const costs = [];
  let minRow = BOARD_SIZE;
  let maxRow = -1;
  let minCol = BOARD_SIZE;
  let maxCol = -1;
  for (const cell of cells) {
    const row = rowOf(cell);
    const col = colOf(cell);
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
    if (col < minCol) minCol = col;
    if (col > maxCol) maxCol = col;
    const slot2 = SLOTS[cell];
    premium[slot2] = (premium[slot2] ?? 0) + 1;
    pathCount += map.pathCountAt(cell);
    const mask = map.directionsAt(cell);
    let cellCost = Number.POSITIVE_INFINITY;
    let hasCross = false;
    let hasConstraint = false;
    for (const direction of DIRECTIONS) {
      if (!mask.has(direction)) continue;
      openings += 1;
      directionsSeen.add(direction);
      for (const mode of mask.modesOf(direction)) {
        modeCounts[mode] += 1;
        if (mode === "cross") hasCross = true;
      }
      const constraint = map.constraintsAt(cell, direction);
      if (constraint.cross !== null) hasConstraint = true;
      if (constraint.minCost !== null && constraint.minCost < cellCost) {
        cellCost = constraint.minCost;
      }
    }
    if (hasCross) crossCells += 1;
    if (hasConstraint) constrainedCells += 1;
    const kinds = new Set(map.candidatesAt(cell).map((candidate) => candidate.kind));
    if (kinds.size === 1) forcedCells += 1;
    let reachesEquals = false;
    for (const axis of AXES2) {
      const span = spans.at(cell, axis);
      if (span === null) continue;
      axesSeen.add(axis);
      spanIds.add(`${axis}:${span.from}`);
      if (span.tokens > longestLine) longestLine = span.tokens;
      if (span.capacity > largestCapacity) largestCapacity = span.capacity;
      if (spans.equalsCost(cell, axis) !== UNREACHABLE) reachesEquals = true;
    }
    if (reachesEquals) equalsReachableCells += 1;
    const cost = Number.isFinite(cellCost) ? cellCost : 1;
    costs.push(cost);
    if (cost < minCost) {
      minCost = cost;
      focus = cell;
    }
    for (const neighbour of neighboursOf(cell)) {
      if (board[neighbour] !== null) {
        boardCells.add(neighbour);
      } else if (inArea[neighbour] !== id) {
        if (inArea[neighbour] === -1) frontier.add(neighbour);
      }
    }
  }
  const anchorSet = new Set(anchorCells);
  const anchorIds = [];
  for (const anchor of map.anchors()) {
    if (!anchorSet.has(anchor.cell)) continue;
    anchorIds.push(anchor.id);
    for (const source of anchor.source) boardCells.add(source);
  }
  return {
    id,
    cells,
    boardCells: [...boardCells].sort((a, b) => a - b),
    bounds: { minRow, maxRow, minCol, maxCol },
    focus,
    openings,
    modeCounts: { ...modeCounts },
    anchorCount: anchorIds.length,
    anchorIds: anchorIds.sort(),
    directions: DIRECTIONS.filter((direction) => directionsSeen.has(direction)),
    axes: AXES2.filter((axis) => axesSeen.has(axis)),
    minCost: Number.isFinite(minCost) ? minCost : 1,
    costs,
    pathCount,
    spanCount: spanIds.size,
    longestLine,
    largestCapacity,
    crossCells,
    constrainedCells,
    forcedCells,
    equalsReachableCells,
    premium,
    frontier: frontier.size,
    truncated: map.stats().truncated
  };
}
function deadCellCount(board, byCell) {
  let count = 0;
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if (board[cell] === null && byCell[cell] === -1) count += 1;
  }
  return count;
}
function neighboursOf(cell) {
  const row = rowOf(cell);
  const col = colOf(cell);
  const out = [];
  if (row > 0) out.push(cell - BOARD_SIZE);
  if (row + 1 < BOARD_SIZE) out.push(cell + BOARD_SIZE);
  if (col > 0) out.push(cell - 1);
  if (col + 1 < BOARD_SIZE) out.push(cell + 1);
  return out;
}

// ../amath-bot-lab/src/areas/score.ts
var DEFAULT_AREA_WEIGHTS = {
  space: {
    // How many ways a line can run through the area's cells.
    openness: 0.2,
    // How much existing structure justifies it. An area with no anchor is
    // unreachable, so this is close to a precondition rather than a bonus.
    anchors: 0.15,
    // Cheapness. A cell one tile from structure is worth more than one four away.
    reach: 0.25,
    // Cells that finish a perpendicular run: two equations scored at once.
    cross: 0.15,
    // How long a line through here could get, which bounds what it can score.
    capacity: 0.1,
    // Premium squares inside the area.
    premium: 0.1,
    // Empty cells beyond it that a later turn could reach.
    growth: 0.05
  },
  area: {
    space: 0.3,
    tileCompatibility: 0.2,
    unseenPotential: 0.2,
    candidateStrength: 0.3
  },
  candidates: {
    count: 0.4,
    best: 0.6
  },
  saturation: {
    anchors: 8,
    frontier: 12,
    candidates: 400,
    // Around what a strong two-multiplier equation scores in this game.
    score: 80,
    premiumPerCell: 1
  }
};
var PREMIUM_CREDIT = {
  px1: 0,
  px2: 0.5,
  px3: 1,
  px3star: 1,
  ex2: 1.5,
  ex3: 2.5
};
function scoreArea(structure, tiles, unseen, candidates, weights2 = DEFAULT_AREA_WEIGHTS) {
  const cellCount = Math.max(1, structure.cells.length);
  const space = weightedMean([
    [weights2.space.openness, clamp(structure.openings / (cellCount * 4))],
    [weights2.space.anchors, saturate(structure.anchorCount, weights2.saturation.anchors)],
    [weights2.space.reach, 1 / Math.max(1, structure.minCost)],
    [weights2.space.cross, clamp(structure.crossCells / cellCount)],
    [weights2.space.capacity, clamp(structure.largestCapacity / BOARD_SIZE)],
    [weights2.space.premium, premiumAccess(structure, weights2)],
    [weights2.space.growth, saturate(structure.frontier, weights2.saturation.frontier)]
  ]);
  const strength = candidates === null ? 0 : weightedMean([
    [weights2.candidates.count, logSaturate(candidates.count, weights2.saturation.candidates)],
    [weights2.candidates.best, saturate(candidates.bestScore, weights2.saturation.score)]
  ]);
  const unseenScore = unseen.potential / 100;
  const areaScore = weightedMean([
    [weights2.area.space, space],
    [weights2.area.tileCompatibility, unseen.rackCompatibility],
    [weights2.area.unseenPotential, unseenScore],
    [weights2.area.candidateStrength, strength]
  ]);
  void tiles;
  return {
    spaceScore: round(space),
    tileCompatibility: round(unseen.rackCompatibility),
    unseenPotential: round(unseenScore),
    candidateStrength: round(strength),
    areaScore: round(areaScore)
  };
}
function premiumAccess(structure, weights2) {
  let credit = 0;
  for (const [slot2, count] of Object.entries(structure.premium)) {
    credit += (PREMIUM_CREDIT[slot2] ?? 0) * count;
  }
  const perCell = credit / Math.max(1, structure.cells.length);
  return saturate(perCell, weights2.saturation.premiumPerCell);
}
function weightedMean(terms) {
  let weighted = 0;
  let total = 0;
  for (const [weight, value2] of terms) {
    weighted += weight * clamp(value2);
    total += weight;
  }
  return total === 0 ? 0 : clamp(weighted / total);
}
function saturate(value2, at) {
  return at <= 0 ? 0 : clamp(value2 / at);
}
function logSaturate(value2, at) {
  if (at <= 0) return 0;
  return clamp(Math.log1p(Math.max(0, value2)) / Math.log1p(at));
}
function clamp(value2) {
  return value2 < 0 ? 0 : value2 > 1 ? 1 : value2;
}
function round(value2) {
  return Math.round(value2 * 1e4) / 1e4;
}

// ../amath-bot-lab/src/areas/unseen.ts
var EQUALS_CAPABLE = ["=", "?"];
var EQUALS_SATURATION = EQUALS_CAPABLE.reduce((total, kind) => total + TOKENS[kind].count, 0) / TOTAL_TILES;
var DEFAULT_UNSEEN_WEIGHTS = {
  fillability: 0.25,
  requirementSupport: 0.35,
  equationSupport: 0.25,
  breadth: 0.15
};
function tileProfileOf(structure, map) {
  const demand = {};
  const required = /* @__PURE__ */ new Set();
  for (const cell of structure.cells) {
    const mask = map.directionsAt(cell);
    for (const direction of DIRECTIONS) {
      if (!mask.has(direction)) continue;
      for (const kind of map.constraintsAt(cell, direction).allowed.kinds) {
        demand[kind] = (demand[kind] ?? 0) + 1;
      }
    }
    const kinds2 = new Set(map.candidatesAt(cell).map((candidate) => candidate.kind));
    if (kinds2.size === 1) {
      for (const kind of kinds2) required.add(kind);
    }
  }
  const kinds = TOKEN_KINDS.filter((kind) => (demand[kind] ?? 0) > 0);
  return {
    demand,
    kinds,
    required: [...required].sort(),
    categories: categoriesOf(kinds)
  };
}
function unseenReadingOf(structure, map, pool, rack, weights2 = DEFAULT_UNSEEN_WEIGHTS) {
  const poolSize = [...pool.values()].reduce((total2, count) => total2 + count, 0);
  const rackCounts = /* @__PURE__ */ new Map();
  for (const kind of rack) rackCounts.set(kind, (rackCounts.get(kind) ?? 0) + 1);
  const admissible = structure.cells.map((cell) => admissibleKinds(map, cell));
  const fill = fillability(structure, admissible, pool, poolSize);
  const requirement = requirementSupport(admissible, pool, poolSize);
  const support = equationSupport(structure, pool, poolSize);
  const width = breadth(admissible, pool);
  const total = weights2.fillability + weights2.requirementSupport + weights2.equationSupport + weights2.breadth;
  const blended = total === 0 ? 0 : (weights2.fillability * fill + weights2.requirementSupport * requirement + weights2.equationSupport * support + weights2.breadth * width) / total;
  return {
    potential: round2(100 * clamp2(blended)),
    fillability: round2(fill),
    requirementSupport: round2(requirement),
    equationSupport: round2(support),
    breadth: round2(width),
    poolSize,
    rackCompatibility: round2(fillability(structure, admissible, rackCounts, rack.length))
  };
}
function fillability(structure, admissible, pool, poolSize) {
  if (poolSize <= 0 || structure.cells.length === 0) return 0;
  let weighted = 0;
  let weights2 = 0;
  for (let index = 0; index < structure.cells.length; index += 1) {
    const cost = Math.max(1, structure.costs[index] ?? 1);
    const weight = 1 / cost;
    let share = 0;
    for (const kind of admissible[index]) share += pool.get(kind) ?? 0;
    weighted += weight * (share / poolSize);
    weights2 += weight;
  }
  return weights2 === 0 ? 0 : clamp2(weighted / weights2);
}
function requirementSupport(admissible, pool, poolSize) {
  if (poolSize <= 0) return 0;
  let worst = 1;
  let constrained = 0;
  for (const kinds of admissible) {
    if (kinds.size >= TOKEN_KINDS.length) continue;
    constrained += 1;
    let share = 0;
    for (const kind of kinds) share += pool.get(kind) ?? 0;
    const value2 = clamp2(share / poolSize);
    if (value2 < worst) worst = value2;
  }
  return constrained === 0 ? 1 : worst;
}
function equationSupport(structure, pool, poolSize) {
  if (structure.equalsReachableCells > 0) return 1;
  if (poolSize <= 0) return 0;
  let supply = 0;
  for (const kind of EQUALS_CAPABLE) supply += pool.get(kind) ?? 0;
  return clamp2(supply / poolSize / EQUALS_SATURATION);
}
function breadth(admissible, pool) {
  if (admissible.length === 0) return 0;
  let served = 0;
  for (const kinds of admissible) {
    for (const kind of kinds) {
      if ((pool.get(kind) ?? 0) > 0) {
        served += 1;
        break;
      }
    }
  }
  return served / admissible.length;
}
function admissibleKinds(map, cell) {
  const kinds = /* @__PURE__ */ new Set();
  const mask = map.directionsAt(cell);
  for (const direction of DIRECTIONS) {
    if (!mask.has(direction)) continue;
    for (const kind of map.constraintsAt(cell, direction).allowed.kinds) kinds.add(kind);
  }
  return kinds;
}
function categoriesOf(kinds) {
  const seen = /* @__PURE__ */ new Set();
  for (const kind of kinds) seen.add(TOKENS[kind].type);
  const order = ["lightNumber", "heavyNumber", "operator", "choice", "equals", "blank"];
  return order.filter((type) => seen.has(type));
}
function clamp2(value2) {
  return value2 < 0 ? 0 : value2 > 1 ? 1 : value2;
}
function round2(value2) {
  return Math.round(value2 * 1e4) / 1e4;
}

// ../amath-bot-lab/src/areas/analyze.ts
function analyzeAreas(position, options = {}) {
  const started = performance.now();
  const map = resolveMap(position, options);
  const spans = options.spans ?? buildSpanIndex(map, position.board);
  const weights2 = options.weights ?? DEFAULT_AREA_WEIGHTS;
  const unseenWeights = options.unseenWeights ?? DEFAULT_UNSEEN_WEIGHTS;
  const topMoves = options.topMoves ?? 5;
  const partition = partitionAreas(map, spans, position.board);
  const attribution = options.moves === void 0 ? null : attributeMoves(options.moves, partition.byCell, partition.groups.length);
  const rackKinds2 = position.rack.map((tile) => tile.kind);
  const areas = partition.groups.map((cells, id) => {
    const structure = structureOf(
      id,
      cells,
      partition.anchorCells[id] ?? [],
      map,
      spans,
      position.board,
      partition.byCell
    );
    const tiles = tileProfileOf(structure, map);
    const unseen = unseenReadingOf(structure, map, position.unseen, rackKinds2, unseenWeights);
    const candidates = attribution === null || options.moves === void 0 ? null : summariseCandidates(
      options.moves,
      attribution.touching[id] ?? [],
      attribution.origins[id] ?? [],
      topMoves
    );
    return {
      structure,
      tiles,
      unseen,
      candidates,
      scores: scoreArea(structure, tiles, unseen, candidates, weights2)
    };
  });
  const ranked = [...areas].sort(
    (a, b) => b.scores.areaScore - a.scores.areaScore || a.structure.id - b.structure.id
  );
  return {
    ranked,
    areas,
    byCell: partition.byCell,
    spaceMapId: map.id,
    boardVersion: boardVersionOf(position.board),
    stats: {
      areaCount: areas.length,
      reachableCells: partition.groups.reduce((total, cells) => total + cells.length, 0),
      deadCells: deadCellCount(position.board, partition.byCell),
      bridgedAreaPairs: partition.bridgedAreaPairs,
      unjustifiedCells: partition.unjustifiedCells,
      candidatesAttributed: options.moves?.length ?? 0,
      movesSpanningAreas: attribution?.spanningAreas ?? 0,
      truncated: map.stats().truncated,
      elapsedMs: performance.now() - started
    }
  };
}
function resolveMap(position, options) {
  const supplied = options.spaceMap;
  if (supplied === void 0) {
    return buildSpaceMap(position, { maxNewTiles: Math.max(1, position.rack.length) });
  }
  const version = boardVersionOf(position.board);
  if (supplied.boardVersion !== version) {
    throw new Error(`areas: the space map describes a different board (${supplied.boardVersion})`);
  }
  return supplied;
}

// ../amath-bot-lab/src/bots/fallback.ts
function fullRackExchange(context) {
  const held = context.state.racks[context.side].length;
  for (const candidate of context.actionSet.exchange) {
    if (candidate.action.type === "exchange" && candidate.action.tileIds.length === held) {
      return candidate;
    }
  }
  return null;
}
function chooseNonPlace(context) {
  const swap = fullRackExchange(context);
  if (swap !== null) return swap.action;
  const pass = context.actionSet.pass;
  if (pass !== null) return pass.action;
  const fallback = context.legal[0];
  if (fallback === void 0) throw new Error("no legal action to fall back on");
  return fallback.action;
}

// ../amath-bot-lab/src/integrated/afterstate.ts
function afterstateOfAction(state, action, gained) {
  switch (action.type) {
    case "place":
      return afterstateOf(state, action, gained);
    case "exchange":
      return afterstateOfExchange(state, action.tileIds);
    case "pass":
      return afterstateOfPass(state);
  }
}
function afterstateOfExchange(state, tileIds) {
  const side = state.activeSide;
  const leaving = new Set(tileIds);
  const held = state.racks[side];
  for (const id of tileIds) {
    if (!held.includes(id)) {
      throw new Error(`afterstate: ${id} is not in the ${side} rack`);
    }
  }
  const rackLeft = held.filter((id) => !leaving.has(id));
  return {
    state: {
      ...state,
      racks: { ...state.racks, [side]: rackLeft },
      bag: [...state.bag, ...tileIds],
      // An exchange scores nothing, so it extends the no-score streak.
      noScoreTail: [...state.noScoreTail, side].slice(-state.rules.noScoreStreakLength),
      activeSide: side,
      terminal: null
    },
    gained: 0,
    rackLeft: rackLeft.length
  };
}
function afterstateOfPass(state) {
  const side = state.activeSide;
  return {
    state: {
      ...state,
      noScoreTail: [...state.noScoreTail, side].slice(-state.rules.noScoreStreakLength),
      activeSide: side,
      terminal: null
    },
    gained: 0,
    rackLeft: state.racks[side].length
  };
}
function afterstateOf(state, action, gained) {
  const side = state.activeSide;
  const placements = action.placements;
  const spent = new Set(placements.map((placement) => placement.tileId));
  const rackLeft = state.racks[side].filter((id) => !spent.has(id));
  const board = withCells(
    state.board,
    placements.map((placement) => {
      const cell = {
        tileId: placement.tileId,
        kind: placement.kind,
        face: placement.face,
        side,
        turn: state.turnNumber
      };
      return [placement.cell, cell];
    })
  );
  const scores = { ...state.scores };
  scores[side] = scores[side] + gained;
  return {
    state: {
      ...state,
      board,
      racks: { ...state.racks, [side]: rackLeft },
      scores,
      // Still our turn: the refill and the hand-over are steps this state stops
      // short of. Keeping `activeSide` also keeps `selfToMove` at 1, which is
      // what every observation in the Stage 5A dataset carries.
      activeSide: side,
      noScoreTail: gained > 0 ? [] : state.noScoreTail,
      hasPlacement: true,
      terminal: null
    },
    gained,
    rackLeft: rackLeft.length
  };
}

// ../amath-bot-lab/src/bot/leave.ts
function shapeOf(rack) {
  const counts = /* @__PURE__ */ new Map();
  let digits = 0;
  let heavyDigits = 0;
  let operators = 0;
  let equals2 = 0;
  let plusMinus = 0;
  let timesDivide = 0;
  let blanks = 0;
  for (const tile of rack) {
    counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1);
    const type = TOKENS[tile.kind].type;
    if (type === "lightNumber") digits += 1;
    else if (type === "heavyNumber") {
      digits += 1;
      heavyDigits += 1;
    } else if (type === "operator") operators += 1;
    else if (type === "equals") equals2 += 1;
    else if (type === "blank") blanks += 1;
    else if (tile.kind === "+/-") {
      operators += 1;
      plusMinus += 1;
    } else if (tile.kind === "x//") {
      operators += 1;
      timesDivide += 1;
    }
  }
  let duplicates = 0;
  for (const count of counts.values()) duplicates += count - 1;
  const canSupplyEquals = equals2 > 0 || blanks > 0;
  const canOpenEquation = canSupplyEquals && digits + blanks >= 2 && rack.length >= 3;
  return {
    tiles: rack.length,
    digits,
    heavyDigits,
    operators,
    equals: equals2,
    plusMinus,
    timesDivide,
    blanks,
    duplicates,
    canOpenEquation,
    canSupplyEquals
  };
}
function retentionOf(kept, context) {
  const refill = Math.min(context.poolCount, Math.max(0, context.rackSize - kept));
  const next = kept + refill;
  return next === 0 ? 0 : kept / next;
}
function evaluateLeave(rack, weights2, idealDigitRatio, context) {
  const shape = shapeOf(rack);
  const retention = retentionOf(shape.tiles, context);
  const components = [];
  const add2 = (name, value2, note) => {
    if (value2 !== 0) components.push({ name, value: value2, note });
  };
  const scaled = (value2) => value2 * retention;
  if (!shape.canSupplyEquals) {
    add2(
      "no-equals",
      scaled(weights2.noEquals),
      `\u0E44\u0E21\u0E48\u0E21\u0E35 = \u0E41\u0E25\u0E30\u0E44\u0E21\u0E48\u0E21\u0E35 blank \u2014 \u0E40\u0E1B\u0E34\u0E14\u0E2A\u0E21\u0E01\u0E32\u0E23\u0E40\u0E2D\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49 (\u0E21\u0E35\u0E1C\u0E25 ${(retention * 100).toFixed(0)}% \u0E02\u0E2D\u0E07\u0E21\u0E37\u0E2D\u0E2B\u0E19\u0E49\u0E32)`
    );
  }
  if (shape.equals > 1) {
    add2("spare-equals", weights2.spareEquals * (shape.equals - 1), `= \u0E40\u0E01\u0E34\u0E19\u0E21\u0E32 ${shape.equals - 1}`);
  }
  if (shape.blanks > 0) {
    add2("blank", weights2.blank * shape.blanks, `blank ${shape.blanks} \u0E15\u0E31\u0E27`);
  }
  const choices = shape.plusMinus + shape.timesDivide;
  if (choices > 0) {
    add2("choice", weights2.choice * choices, `\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E17\u0E32\u0E07\u0E40\u0E25\u0E37\u0E2D\u0E01 ${choices} \u0E15\u0E31\u0E27`);
  }
  if (shape.tiles > 0) {
    const wanted = shape.operators * idealDigitRatio;
    const off = Math.abs(shape.digits - wanted);
    add2(
      "balance",
      scaled(weights2.imbalance * off),
      `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02 ${shape.digits} \u0E15\u0E48\u0E2D\u0E40\u0E04\u0E23\u0E37\u0E48\u0E2D\u0E07\u0E2B\u0E21\u0E32\u0E22 ${shape.operators} (\u0E04\u0E27\u0E23\u0E23\u0E32\u0E27 ${wanted.toFixed(1)})`
    );
  }
  if (shape.heavyDigits > 0) {
    add2("heavy", weights2.heavy * shape.heavyDigits, `\u0E40\u0E1A\u0E35\u0E49\u0E22 10-20 \u0E08\u0E33\u0E19\u0E27\u0E19 ${shape.heavyDigits}`);
  }
  if (shape.duplicates > 0) {
    add2("duplicate", weights2.duplicate * shape.duplicates, `\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E0B\u0E49\u0E33 ${shape.duplicates}`);
  }
  if (shape.tiles > 0 && !shape.canOpenEquation) {
    add2("too-short", scaled(weights2.tooShort), "\u0E40\u0E1A\u0E35\u0E49\u0E22\u0E17\u0E35\u0E48\u0E40\u0E2B\u0E25\u0E37\u0E2D\u0E1B\u0E23\u0E30\u0E01\u0E2D\u0E1A\u0E2A\u0E21\u0E01\u0E32\u0E23\u0E40\u0E2D\u0E07\u0E44\u0E21\u0E48\u0E44\u0E14\u0E49");
  }
  return {
    shape,
    retention,
    components,
    total: components.reduce((sum2, item) => sum2 + item.value, 0)
  };
}

// ../amath-bot-lab/src/bot/lookahead.ts
function rackAfter(rack, placements) {
  const remaining = [...rack];
  for (const placement of placements) {
    const index = remaining.findIndex((tile) => tile.kind === placement.kind);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

// ../amath-bot-lab/src/bot/weights.ts
var DEFAULT_CONFIG = {
  evaluation: {
    score: 1,
    leave: 1,
    board: 1,
    continuation: 1,
    opponent: 0.6
  },
  leave: {
    noEquals: -6,
    spareEquals: 0.5,
    blank: 6,
    choice: 1.5,
    imbalance: -1.2,
    heavy: -0.8,
    duplicate: -0.4,
    tooShort: -3
  },
  board: {
    openTriple: -1.4,
    openDouble: -0.5,
    reachPerCell: 0.02,
    reachCap: 3
  },
  idealDigitRatio: 1.6
};

// ../amath-bot-lab/src/integrated/evaluate.ts
function evaluateAction(legal, position, areaMap, config) {
  const action = legal.action;
  const kept = action.type === "exchange" ? rackAfterExchange(position, action.tileIds) : [...position.rack];
  const best = areaMap.ranked[0];
  const areaPotential = best?.scores.areaScore ?? 0;
  const unseenPotential = (best?.unseen.potential ?? 0) / 100;
  const leave = evaluateLeave(kept, config.leave, config.idealDigitRatio, {
    rackSize: position.rules.rackSize,
    poolCount: position.poolCount
  });
  const spent = position.rack.length - kept.length;
  const components = [
    component("immediate-score", 0, config.weights.immediateScore, "places nothing"),
    component(
      "area-potential",
      areaPotential,
      config.weights.areaPotential,
      "the board's best area, which this action does not change"
    ),
    component(
      "unseen-potential",
      unseenPotential,
      config.weights.unseenPotential,
      `${(best?.unseen.potential ?? 0).toFixed(1)}% of the unseen pool`
    ),
    component(
      "leave",
      leave.total,
      config.weights.leave,
      spent > 0 ? `swaps ${spent}, keeps ${kept.length}` : "the rack is unchanged"
    )
  ];
  if (isScorelessTurn(action) && config.weights.scorelessTurnCost !== 0) {
    components.push(
      component(
        "scoreless-turn",
        1,
        config.weights.scorelessTurnCost,
        "spends a turn without playing a tile, and feeds the no-score streak"
      )
    );
  }
  const staticValue = sum(components);
  return {
    id: legal.id,
    action,
    family: action.type,
    move: null,
    areaId: best?.structure.id ?? -1,
    areaIds: [],
    immediateScore: 0,
    areaPotential,
    unseenPotential,
    leaveValue: leave.total,
    futureAccess: null,
    exposure: null,
    nnAfter: null,
    nnDelta: null,
    staticValue,
    value: staticValue,
    deep: false,
    components
  };
}
function rackAfterExchange(position, leaving) {
  const gone = new Set(leaving);
  return position.rack.filter((tile) => !gone.has(tile.id));
}
function evaluateStatic(move, index, position, areaMap, originOf, config) {
  const areaId = originOf[index] ?? -1;
  const area = areaId >= 0 ? areaMap.areas[areaId] : void 0;
  const areaPotential = area?.scores.areaScore ?? 0;
  const unseenPotential = area === void 0 ? 0 : area.unseen.potential / 100;
  const leave = evaluateLeave(
    rackAfter(position.rack, move.placements),
    config.leave,
    config.idealDigitRatio,
    { rackSize: position.rules.rackSize, poolCount: position.poolCount }
  );
  const weights2 = config.weights;
  const components = [
    component("immediate-score", move.score, weights2.immediateScore, `${move.score} points`),
    component(
      "area-potential",
      areaPotential,
      weights2.areaPotential,
      areaId >= 0 ? `area ${areaId} scores ${areaPotential.toFixed(3)}` : "no area covers it"
    ),
    component(
      "unseen-potential",
      unseenPotential,
      weights2.unseenPotential,
      area === void 0 ? "no area" : `${area.unseen.potential.toFixed(1)}% of the unseen pool`
    ),
    component(
      "leave",
      leave.total,
      weights2.leave,
      `${move.newTileCount} tiles spent, ${position.rack.length - move.newTileCount} kept`
    )
  ];
  const staticValue = sum(components);
  return {
    id: move.id,
    action: { type: "place", placements: move.placements },
    family: "place",
    move,
    areaId,
    areaIds: areasTouching(move, areaMap),
    immediateScore: move.score,
    areaPotential,
    unseenPotential,
    leaveValue: leave.total,
    futureAccess: null,
    exposure: null,
    nnAfter: null,
    nnDelta: null,
    staticValue,
    value: staticValue,
    deep: false,
    components
  };
}
function deepComponents(afterAreas, beforeAreas, nnAfter, nnBefore, config) {
  const weights2 = config.weights;
  const access = futureAccessOf(afterAreas);
  const exposed = exposureOf(beforeAreas, afterAreas, config.budget.exposureSaturation);
  const delta = nnAfter === null || nnBefore === null ? null : nnAfter - nnBefore;
  const components = [
    component(
      "future-access",
      access,
      weights2.futureAccess,
      `${afterAreas.stats.areaCount} areas remain, top space score ${topSpace(afterAreas).toFixed(3)}`
    ),
    component(
      "exposure",
      exposed,
      weights2.exposure,
      exposed === 0 ? "opens no new premium square" : "opens premium squares to the next mover"
    )
  ];
  if (delta !== null) {
    components.push(
      component(
        "nn-value",
        delta,
        weights2.nnValue,
        `P(win) ${nnBefore.toFixed(4)} \u2192 ${nnAfter.toFixed(4)}`
      )
    );
  }
  return { components, futureAccess: access, exposure: exposed, nnDelta: delta };
}
function evaluateDeep(candidate, afterAreas, beforeAreas, nnAfter, nnBefore, config) {
  const deep = deepComponents(afterAreas, beforeAreas, nnAfter, nnBefore, config);
  const components = [...candidate.components, ...deep.components];
  return {
    ...candidate,
    futureAccess: deep.futureAccess,
    exposure: deep.exposure,
    nnAfter,
    nnDelta: deep.nnDelta,
    value: sum(components),
    deep: true,
    components
  };
}
function futureAccessOf(after) {
  if (after.ranked.length === 0) return 0;
  const top = after.ranked.slice(0, 3);
  return top.reduce((total, area) => total + area.scores.spaceScore, 0) / top.length;
}
function topSpace(after) {
  return after.ranked[0]?.scores.spaceScore ?? 0;
}
function exposureOf(before, after, saturation) {
  let credit = 0;
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    if ((after.byCell[cell] ?? -1) < 0) continue;
    if ((before.byCell[cell] ?? -1) >= 0) continue;
    credit += PREMIUM_CREDIT[SLOTS[cell]] ?? 0;
  }
  if (saturation <= 0) return 0;
  const value2 = credit / saturation;
  return value2 > 1 ? 1 : value2;
}
function areasTouching(move, areaMap) {
  const seen = /* @__PURE__ */ new Set();
  for (const cell of move.newCells) {
    const area = areaMap.byCell[cell] ?? -1;
    if (area >= 0) seen.add(area);
  }
  return [...seen].sort((a, b) => a - b);
}
function component(name, raw, weight, note) {
  return { name, raw, weight, points: raw * weight, note };
}
function sum(components) {
  return components.reduce((total, item) => total + item.points, 0);
}

// ../amath-bot-lab/src/integrated/weights.ts
var DEFAULT_BOT_WEIGHTS = {
  immediateScore: 1,
  // A whole turn's worth of positional advantage is a few points, not tens.
  areaPotential: 8,
  unseenPotential: 4,
  futureAccess: 6,
  exposure: -6,
  leave: 1,
  // Zero: the term exists and is measured, and nothing has earned a non-zero
  // default yet. See the note on the field.
  scorelessTurnCost: 0,
  // A model that moves from 0.5 to 0.6 about a move is saying something worth
  // roughly a small equation. Deliberately modest for a model that has never
  // been asked about an afterstate before.
  nnValue: 30
};
var DEFAULT_BUDGET2 = {
  deepTop: 16,
  deepExchanges: 6,
  topMovesPerArea: 5,
  topAreas: 8,
  keepCandidates: 24,
  exposureSaturation: 5,
  families: "all"
};
var DEFAULT_BOT_CONFIG = {
  weights: DEFAULT_BOT_WEIGHTS,
  area: DEFAULT_AREA_WEIGHTS,
  unseen: DEFAULT_UNSEEN_WEIGHTS,
  leave: DEFAULT_CONFIG.leave,
  idealDigitRatio: DEFAULT_CONFIG.idealDigitRatio,
  budget: DEFAULT_BUDGET2
};

// ../amath-bot-lab/src/integrated/pipeline.ts
var IntegrationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "IntegrationError";
  }
};
function decide(context, options = {}) {
  const started = performance.now();
  const config = options.config ?? DEFAULT_BOT_CONFIG;
  const value2 = options.value ?? null;
  const position = envPosition(context.state, context.side);
  const generateStart = performance.now();
  const generated = placementsFor(context, position);
  const generateMs = performance.now() - generateStart;
  const canonical = new Set(context.actionSet.place.map((action2) => action2.id));
  const mine = new Set(generated.moves.map((move) => move.id));
  let missing = 0;
  for (const id of canonical) {
    if (!mine.has(id)) missing += 1;
  }
  let extra = 0;
  for (const id of mine) {
    if (!canonical.has(id)) extra += 1;
  }
  if (missing > 0 || extra > 0) {
    throw new IntegrationError(
      `${generated.reused ? "the environment supplied" : "regenerated"} ${generated.moves.length} placements against the environment's ${context.actionSet.place.length}: ${missing} missing, ${extra} extra`
    );
  }
  const areasStart = performance.now();
  const areaMap = analyzeAreas(position, {
    spaceMap: generated.spaceMap,
    spans: generated.spans,
    moves: generated.moves,
    topMoves: config.budget.topMovesPerArea,
    weights: config.area,
    unseenWeights: config.unseen
  });
  const areasMs = performance.now() - areasStart;
  const nnBefore = value2 === null ? null : value2.evaluate({
    state: context.state,
    side: context.side,
    history: context.history
  }).probability;
  const staticStart = performance.now();
  const originOf = originsOf(generated.moves, areaMap);
  const candidates = generated.moves.map(
    (move, index) => evaluateStatic(move, index, position, areaMap, originOf, config)
  );
  if (config.budget.families === "all") {
    for (const legal of context.actionSet.exchange) {
      candidates.push(evaluateAction(legal, position, areaMap, config));
    }
    if (context.actionSet.pass !== null) {
      candidates.push(evaluateAction(context.actionSet.pass, position, areaMap, config));
    }
  }
  candidates.sort(byValueThenId);
  const staticMs = performance.now() - staticStart;
  const deepStart = performance.now();
  let inferences = 0;
  const quota = {
    place: config.budget.deepTop,
    exchange: config.budget.families === "all" ? config.budget.deepExchanges : 0,
    pass: config.budget.families === "all" ? 1 : 0
  };
  const deepened = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const family = candidates[index].family;
    if ((quota[family] ?? 0) <= 0) continue;
    quota[family] = (quota[family] ?? 0) - 1;
    deepened.push(index);
  }
  for (const index of deepened) {
    const candidate = candidates[index];
    const after = afterstateOfAction(context.state, candidate.action, candidate.immediateScore);
    const afterPosition = envPosition(after.state, context.side);
    const afterAreas = analyzeAreas(afterPosition, {
      topMoves: 0,
      weights: config.area,
      unseenWeights: config.unseen
    });
    let nnAfter = null;
    if (value2 !== null) {
      const reading2 = value2.evaluate({
        state: after.state,
        side: context.side,
        history: context.history
      });
      nnAfter = reading2.probability;
      if (!reading2.cached) inferences += 1;
    }
    candidates[index] = evaluateDeep(candidate, afterAreas, areaMap, nnAfter, nnBefore, config);
  }
  candidates.sort(byValueThenId);
  const deepMs = performance.now() - deepStart;
  const chosen = candidates[0] ?? null;
  const kept = candidates.slice(0, config.budget.keepCandidates);
  const action = chosen === null ? chooseNonPlace(context) : chosen.action;
  const trace = {
    turnNumber: context.turnNumber,
    ply: context.ply,
    side: context.side,
    scores: {
      self: position.scores[context.side],
      opponent: position.scores[context.side === "A" ? "B" : "A"]
    },
    legal: {
      place: context.actionSet.place.length,
      exchange: context.actionSet.exchange.length,
      pass: context.actionSet.pass === null ? 0 : 1
    },
    generator: generated.stats,
    recall: {
      canonical: canonical.size,
      regenerated: mine.size,
      missing,
      extra,
      source: generated.reused ? "environment" : "regenerated"
    },
    areas: {
      count: areaMap.stats.areaCount,
      deadCells: areaMap.stats.deadCells,
      bridgedAreaPairs: areaMap.stats.bridgedAreaPairs,
      movesSpanningAreas: areaMap.stats.movesSpanningAreas,
      unattributed: areaMap.stats.unjustifiedCells,
      truncated: areaMap.stats.truncated
    },
    nn: {
      available: value2 !== null,
      before: nnBefore,
      inferences,
      cacheHits: value2?.stats.hits ?? 0,
      artifact: value2?.model.meta.trainedOn.run ?? null
    },
    timings: {
      generateMs,
      areasMs,
      staticMs,
      deepMs,
      totalMs: performance.now() - started
    }
  };
  return {
    action,
    kind: action.type,
    chosen,
    candidates: kept,
    areas: areaMap.ranked.slice(0, config.budget.topAreas),
    areaMap,
    trace,
    config,
    reason: reasonOf(chosen, action, areaMap, nnBefore)
  };
}
function placementsFor(context, position) {
  const supplied = context.actionSet.source;
  if (supplied !== null && context.side === context.state.activeSide) {
    return {
      moves: supplied.moves,
      spaceMap: supplied.spaceMap,
      spans: supplied.spans,
      stats: context.actionSet.generator,
      reused: true
    };
  }
  const generated = generateMoves(position, {});
  return {
    moves: generated.moves,
    spaceMap: generated.spaceMap,
    spans: generated.spans,
    stats: generated.stats,
    reused: false
  };
}
function originsOf(moves, areaMap) {
  const out = new Int16Array(moves.length).fill(-1);
  for (let index = 0; index < moves.length; index += 1) {
    for (const cell of moves[index].newCells) {
      const area = areaMap.byCell[cell] ?? -1;
      if (area >= 0) {
        out[index] = area;
        break;
      }
    }
  }
  return out;
}
function byValueThenId(a, b) {
  if (b.value !== a.value) return b.value - a.value;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function reasonOf(chosen, action, areaMap, nnBefore) {
  if (chosen === null) {
    return action.type === "exchange" ? "no placement exists; exchanging the rack" : "no placement exists and no exchange is allowed; passing";
  }
  const parts = [...chosen.components].filter((item) => Math.abs(item.points) >= 0.5).sort((a, b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, 3).map((item) => `${item.name} ${item.points >= 0 ? "+" : ""}${item.points.toFixed(1)}`);
  const area = chosen.areaId >= 0 ? areaMap.areas[chosen.areaId] : void 0;
  const where = area === void 0 ? "outside every area" : `area ${chosen.areaId} (score ${area.scores.areaScore.toFixed(2)}, unseen ${area.unseen.potential.toFixed(0)}%)`;
  const model = nnBefore === null ? "" : `; P(win) here ${nnBefore.toFixed(3)}`;
  return `${chosen.immediateScore} points in ${where}: ${parts.join(", ")}${model}`;
}

// ../amath-bot-lab/src/repr/version.ts
var REPRESENTATION_VERSION = "amath-repr-1";
function assertRepresentationVersion(version, where) {
  if (version !== REPRESENTATION_VERSION) {
    throw new Error(
      `${where}: representation version ${version} was written by a different build; this one speaks ${REPRESENTATION_VERSION}. Re-encode rather than mixing them.`
    );
  }
}

// ../amath-bot-lab/src/repr/vocab.ts
var KINDS = TOKEN_KINDS;
var KIND_COUNT = KINDS.length;
var FACES = faceTableFor(BOT_RULES).faces;
var FACE_COUNT = FACES.length;
var SLOT_TYPES = ["px1", "px2", "px3", "px3star", "ex2", "ex3"];
var SLOT_COUNT = SLOT_TYPES.length;
var KIND_INDEX = new Map(KINDS.map((kind, index) => [kind, index]));
var FACE_INDEX = new Map(FACES.map((face, index) => [face, index]));
var SLOT_INDEX = new Map(SLOT_TYPES.map((slot2, index) => [slot2, index]));
function kindIndex(kind) {
  const index = KIND_INDEX.get(kind);
  if (index === void 0) throw new Error(`repr: unknown tile kind ${JSON.stringify(kind)}`);
  return index;
}
function faceIndex(face) {
  const index = FACE_INDEX.get(face);
  if (index === void 0) throw new Error(`repr: unknown face ${JSON.stringify(face)}`);
  return index;
}
function slotIndex(slot2) {
  const index = SLOT_INDEX.get(slot2);
  if (index === void 0) throw new Error(`repr: unknown slot type ${JSON.stringify(slot2)}`);
  return index;
}
var CH_EMPTY = 0;
var CH_KIND = 1;
var CH_FACE = CH_KIND + KIND_COUNT;
var CH_PLACED_SELF = CH_FACE + FACE_COUNT;
var CH_PLACED_OPPONENT = CH_PLACED_SELF + 1;
var CH_SLOT = CH_PLACED_OPPONENT + 1;
var CHANNELS = CH_SLOT + SLOT_COUNT;
var SLOT_INDEX_BY_CELL = SLOTS.map((slot2) => slotIndex(slot2));

// ../amath-bot-lab/src/repr/observe.ts
var DEFAULT_HISTORY_WINDOW = 8;
function observe(state, options = {}) {
  if (state.terminal !== null) {
    throw new Error(
      "repr: a terminal state has no decision to observe. The game's result is attached at OUTCOME TIME by `attachOutcome`, never read out of the state being encoded."
    );
  }
  assertDecisionInvariants(state);
  const seat = options.side ?? state.activeSide;
  const window = options.historyWindow ?? DEFAULT_HISTORY_WINDOW;
  if (!Number.isInteger(window) || window < 0) {
    throw new Error(`repr: historyWindow must be a non-negative integer, got ${String(window)}`);
  }
  const position = envPosition(state, seat);
  const opponent = otherSide(seat);
  const rack = [...position.rack].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const rackCounts = countsOf(rack.map((tile) => tile.kind));
  const unseenCounts = new Array(KIND_COUNT).fill(0);
  for (const [kind, count] of position.unseen) unseenCounts[kindIndex(kind)] = count;
  return {
    representationVersion: REPRESENTATION_VERSION,
    rules: position.rules.id,
    seat,
    activeSeat: state.activeSide,
    selfToMove: state.activeSide === seat,
    turnNumber: position.turnNumber,
    board: observedBoard(position.board, seat),
    rack: rack.map((tile) => tile.id),
    rackKinds: rack.map((tile) => tile.kind),
    rackCounts,
    unseenCounts,
    poolCount: position.poolCount,
    opponentRackCount: position.opponentRackCount,
    ownSetAside: [...position.ownSetAside].map((tile) => tile.kind).sort(),
    opponentSetAsideCount: position.opponentSetAsideCount,
    scoreSelf: position.scores[seat],
    scoreOpponent: position.scores[opponent],
    noScoreStreakLength: position.noScoreStreak,
    hasPlacement: state.hasPlacement,
    history: observedHistory(state, options.history ?? [], seat, window),
    historyWindow: window
  };
}
function observedBoard(board, seat) {
  const cells = [];
  board.forEach((cell, index) => {
    if (cell === null) return;
    cells.push({
      cell: index,
      kind: cell.kind,
      face: cell.face,
      placedBy: cell.side === seat ? "self" : "opponent",
      turn: cell.turn
    });
  });
  return cells;
}
function observedHistory(state, events, seat, window) {
  if (window === 0) return [];
  const tail = events.slice(Math.max(0, events.length - window));
  return tail.map((event) => observedTurn(state, event, seat));
}
function observedTurn(state, event, seat) {
  const by = event.seat === seat ? "self" : "opponent";
  const opponent = otherSide(seat);
  const base = {
    turnNumber: event.turnNumber,
    by,
    scoreGained: event.scoreGained,
    rackCountAfter: {
      self: event.rackCountAfter[seat],
      opponent: event.rackCountAfter[opponent]
    }
  };
  switch (event.action.type) {
    case "place": {
      const placements = [...event.action.placements].sort((a, b) => a.cell - b.cell);
      return {
        ...base,
        type: "place",
        placedCells: placements.map((placement) => placement.cell),
        placedKinds: placements.map((placement) => placement.kind),
        placedFaces: placements.map((placement) => placement.face),
        exchangedCount: 0,
        exchangedKinds: null
      };
    }
    case "exchange": {
      const kinds = event.action.tileIds.map((id) => tileKind(state.manifest, id)).sort();
      return {
        ...base,
        type: "exchange",
        placedCells: [],
        placedKinds: [],
        placedFaces: [],
        exchangedCount: event.action.tileIds.length,
        exchangedKinds: by === "self" ? kinds : null
      };
    }
    case "exchange-unknown":
      return {
        ...base,
        type: "exchange",
        placedCells: [],
        placedKinds: [],
        placedFaces: [],
        exchangedCount: event.action.count,
        // Null even when the observer is the one who made it. The mask above
        // hides an opponent's kinds because no player at the table knows them;
        // here NOBODY knows them, the record included, and `null` is already
        // the word for that. Filling it with an empty list would say the turn
        // swapped nothing, which is the one thing it certainly did not do.
        exchangedKinds: null
      };
    case "pass":
      return {
        ...base,
        type: "pass",
        placedCells: [],
        placedKinds: [],
        placedFaces: [],
        exchangedCount: 0,
        exchangedKinds: null
      };
  }
}
function countsOf(kinds) {
  const counts = new Array(KIND_COUNT).fill(0);
  for (const kind of kinds) {
    const at = kindIndex(kind);
    counts[at] = counts[at] + 1;
  }
  return counts;
}

// ../amath-bot-lab/src/repr/action.ts
var EMPTY_NUMBERS = Object.freeze([]);

// ../amath-bot-lab/src/repr/encode.ts
var SCALARS = [
  "scoreSelf",
  "scoreOpponent",
  "poolCount",
  "opponentRackCount",
  "ownSetAsideCount",
  "opponentSetAsideCount",
  "turnNumber",
  "noScoreStreakLength",
  "selfToMove"
];
var SCALAR_COUNT = SCALARS.length;
var HISTORY_PRESENT = 0;
var HISTORY_BY_SELF = 1;
var HISTORY_BY_OPPONENT = 2;
var HISTORY_TYPE = 3;
var HISTORY_PLACED_COUNT = 6;
var HISTORY_EXCHANGED_COUNT = 7;
var HISTORY_EXCHANGED_KINDS = 8;
var HISTORY_SCORE_GAINED = HISTORY_EXCHANGED_KINDS + KIND_COUNT;
var HISTORY_RACK_SELF = HISTORY_SCORE_GAINED + 1;
var HISTORY_RACK_OPPONENT = HISTORY_RACK_SELF + 1;
var HISTORY_TURN_NUMBER = HISTORY_RACK_OPPONENT + 1;
var HISTORY_WIDTH = HISTORY_TURN_NUMBER + 1;
var SLOT_ROW = 1;
var SLOT_COL = SLOT_ROW + BOT_RULES.boardSize;
var SLOT_KIND = SLOT_COL + BOT_RULES.boardSize;
var SLOT_FACE = SLOT_KIND + KIND_COUNT;
var SLOT_WIDTH = SLOT_FACE + FACE_COUNT;
var MAX_PLACEMENTS = BOT_RULES.rackSize;
var BOARD_LENGTH = CELL_COUNT * CHANNELS;
function encodeObservation(observation) {
  assertRepresentationVersion(observation.representationVersion, "encodeObservation");
  const board = new Uint8Array(BOARD_LENGTH);
  const boardTurn = new Uint16Array(CELL_COUNT);
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    const base = cell * CHANNELS;
    board[base + CH_EMPTY] = 1;
    board[base + CH_SLOT + SLOT_INDEX_BY_CELL[cell]] = 1;
  }
  for (const occupied of observation.board) {
    const base = occupied.cell * CHANNELS;
    board[base + CH_EMPTY] = 0;
    board[base + CH_KIND + kindIndex(occupied.kind)] = 1;
    board[base + CH_FACE + faceIndex(occupied.face)] = 1;
    board[base + (occupied.placedBy === "self" ? CH_PLACED_SELF : CH_PLACED_OPPONENT)] = 1;
    boardTurn[occupied.cell] = occupied.turn;
  }
  const rack = Uint8Array.from(observation.rackCounts);
  const unseen = Uint8Array.from(observation.unseenCounts);
  const scalars = new Float32Array(SCALAR_COUNT);
  scalars[0] = observation.scoreSelf;
  scalars[1] = observation.scoreOpponent;
  scalars[2] = observation.poolCount;
  scalars[3] = observation.opponentRackCount;
  scalars[4] = observation.ownSetAside.length;
  scalars[5] = observation.opponentSetAsideCount;
  scalars[6] = observation.turnNumber;
  scalars[7] = observation.noScoreStreakLength;
  scalars[8] = observation.selfToMove ? 1 : 0;
  return {
    representationVersion: REPRESENTATION_VERSION,
    board,
    boardTurn,
    rack,
    unseen,
    scalars,
    history: encodeHistory(observation.history, observation.historyWindow),
    historyWindow: observation.historyWindow
  };
}
function encodeHistory(turns, window) {
  const history = new Float32Array(window * HISTORY_WIDTH);
  const used = Math.min(turns.length, window);
  const offset = window - used;
  for (let index = 0; index < used; index += 1) {
    const turn = turns[turns.length - used + index];
    const base = (offset + index) * HISTORY_WIDTH;
    history[base + HISTORY_PRESENT] = 1;
    history[base + (turn.by === "self" ? HISTORY_BY_SELF : HISTORY_BY_OPPONENT)] = 1;
    history[base + HISTORY_TYPE + typeIndex(turn.type)] = 1;
    history[base + HISTORY_PLACED_COUNT] = turn.placedCells.length;
    history[base + HISTORY_EXCHANGED_COUNT] = turn.exchangedCount;
    for (const kind of turn.exchangedKinds ?? []) {
      const at = base + HISTORY_EXCHANGED_KINDS + kindIndex(kind);
      history[at] = history[at] + 1;
    }
    history[base + HISTORY_SCORE_GAINED] = turn.scoreGained;
    history[base + HISTORY_RACK_SELF] = turn.rackCountAfter.self;
    history[base + HISTORY_RACK_OPPONENT] = turn.rackCountAfter.opponent;
    history[base + HISTORY_TURN_NUMBER] = turn.turnNumber;
  }
  return history;
}
function typeIndex(type) {
  return type === "place" ? 0 : type === "exchange" ? 1 : 2;
}

// ../amath-bot-lab/src/eval/digest.ts
var OFFSET = 0xcbf29ce484222325n;
var PRIME = 0x100000001b3n;
var MASK = 0xffffffffffffffffn;
var DigestBuilder = class {
  #hash = OFFSET;
  #lines = 0;
  add(line2) {
    this.#lines += 1;
    let hash = this.#hash;
    for (let i = 0; i < line2.length; i += 1) {
      hash = (hash ^ BigInt(line2.charCodeAt(i))) & MASK;
      hash = hash * PRIME & MASK;
    }
    hash = (hash ^ 0x0an) & MASK;
    hash = hash * PRIME & MASK;
    this.#hash = hash;
  }
  /** How many lines have been folded in. Part of the digest's own accounting. */
  get lines() {
    return this.#lines;
  }
  get value() {
    return this.#hash.toString(16).padStart(16, "0");
  }
};
function digestOf(lines) {
  const builder = new DigestBuilder();
  for (const line2 of lines) builder.add(line2);
  return builder.value;
}

// ../amath-bot-lab/src/repr/serialize.ts
function encodedObservationDigest(encoded) {
  return digestOf([
    `v=${encoded.representationVersion}`,
    `window=${encoded.historyWindow}`,
    line("board", encoded.board),
    line("boardTurn", encoded.boardTurn),
    line("rack", encoded.rack),
    line("unseen", encoded.unseen),
    line("scalars", encoded.scalars),
    line("history", encoded.history)
  ]);
}
function line(name, values) {
  const parts = [`${name}:${values.length}`];
  for (let index = 0; index < values.length; index += 1) {
    const value2 = values[index];
    if (value2 !== 0) parts.push(`${index}=${value2}`);
  }
  return parts.join(",");
}

// ../amath-bot-lab/src/repr/size.ts
var ACTION_BYTES_FROM_LAYOUT = 3 + MAX_PLACEMENTS * SLOT_WIDTH + KIND_COUNT;

// ../amath-bot-lab/src/nn/loader.ts
function loadValueModel(meta2, bytes2) {
  if (meta2.artifact !== "amath-stage5a-value") {
    throw new Error(`nn: ${meta2.artifact} is not a Stage 5A value artifact`);
  }
  if (meta2.artifactVersion !== 1) {
    throw new Error(`nn: artifact version ${meta2.artifactVersion} is not one this build reads`);
  }
  assertRepresentationVersion(meta2.representationVersion, "loadValueModel");
  if (bytes2.byteLength !== meta2.bytes) {
    throw new Error(
      `nn: weights are ${bytes2.byteLength} bytes, the manifest declares ${meta2.bytes}`
    );
  }
  if (meta2.bytes % 4 !== 0) throw new Error(`nn: ${meta2.bytes} bytes is not whole float32s`);
  const all = new Float32Array(bytes2);
  const views = /* @__PURE__ */ new Map();
  for (const spec of meta2.tensors) {
    const expected = spec.shape.reduce((product, dimension) => product * dimension, 1);
    if (expected !== spec.count) {
      throw new Error(
        `nn: tensor ${spec.name} declares ${spec.count} floats for shape ${spec.shape.join("\xD7")}`
      );
    }
    if (spec.offset + spec.count > all.length) {
      throw new Error(`nn: tensor ${spec.name} runs past the end of the buffer`);
    }
    views.set(spec.name, all.subarray(spec.offset, spec.offset + spec.count));
  }
  return {
    meta: meta2,
    blocks: meta2.blocks,
    tensor(name) {
      const found = views.get(name);
      if (found === void 0) throw new Error(`nn: the artifact carries no tensor ${name}`);
      return found;
    }
  };
}

// ../amath-bot-lab/src/nn/blocks.ts
function modelInput(model, encoded) {
  const meta2 = model.meta;
  if (encoded.historyWindow !== meta2.historyWindow) {
    throw new Error(
      `nn: the model was trained on a history window of ${meta2.historyWindow}, this observation carries ${encoded.historyWindow}`
    );
  }
  const planeWidth = meta2.boardPlaneWidth;
  if (encoded.board.length !== planeWidth) {
    throw new Error(
      `nn: the board planes are ${encoded.board.length} wide, the model expects ${planeWidth}`
    );
  }
  const ones = [];
  for (let index = 0; index < planeWidth; index += 1) {
    if (encoded.board[index] === 1) ones.push(index);
  }
  const turn = new Float32Array(CELL_COUNT);
  const turnMean = model.tensor("mean__board_turn");
  const turnStd = model.tensor("std__board_turn");
  for (let cell = 0; cell < CELL_COUNT; cell += 1) {
    turn[cell] = (encoded.boardTurn[cell] - turnMean[cell]) / turnStd[cell];
  }
  return {
    boardOneHot: Int32Array.from(ones),
    boardTurn: turn,
    rack: standardize(model, "rack", encoded.rack),
    unseen: standardize(model, "unseen", encoded.unseen),
    scalars: standardize(model, "scalars", encoded.scalars),
    history: standardize(model, "history", encoded.history)
  };
}
function standardize(model, name, values) {
  const mean = model.tensor(`mean__${name}`);
  const std = model.tensor(`std__${name}`);
  if (values.length !== mean.length) {
    throw new Error(
      `nn: block ${name} is ${values.length} wide, the model's statistics are ${mean.length}`
    );
  }
  const out = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    out[index] = (values[index] - mean[index]) / std[index];
  }
  return out;
}

// ../amath-bot-lab/src/nn/forward.ts
function valueLogit(model, input) {
  const parts = [];
  for (const block of model.blocks) {
    parts.push(block === "board" ? boardEncoder(model, input) : denseEncoder(model, block, input));
  }
  let width = 0;
  for (const part of parts) width += part.length;
  const concat = new Float32Array(width);
  let at = 0;
  for (const part of parts) {
    concat.set(part, at);
    at += part.length;
  }
  const trunk = relu(linear(concat, model.tensor("W_trunk"), model.tensor("b_trunk")));
  const head = linear(trunk, model.tensor("W_head"), model.tensor("b_head"));
  return head[0];
}
function winProbability(model, input) {
  return sigmoid(valueLogit(model, input));
}
function boardEncoder(model, input) {
  const weights2 = model.tensor("W_board");
  const bias = model.tensor("b_board");
  const units = bias.length;
  const out = new Float32Array(bias);
  for (const index of input.boardOneHot) {
    const base = index * units;
    for (let unit = 0; unit < units; unit += 1) out[unit] += weights2[base + unit];
  }
  const turnBase = model.meta.boardPlaneWidth;
  const turn = input.boardTurn;
  for (let cell = 0; cell < turn.length; cell += 1) {
    const value2 = turn[cell];
    if (value2 === 0) continue;
    const base = (turnBase + cell) * units;
    for (let unit = 0; unit < units; unit += 1) out[unit] += value2 * weights2[base + unit];
  }
  return relu(out);
}
function denseEncoder(model, block, input) {
  const values = blockOf(input, block);
  return relu(linear(values, model.tensor(`W_${block}`), model.tensor(`b_${block}`)));
}
function blockOf(input, block) {
  switch (block) {
    case "rack":
      return input.rack;
    case "unseen":
      return input.unseen;
    case "scalars":
      return input.scalars;
    case "history":
      return input.history;
    default:
      throw new Error(`nn: the artifact names a block this build cannot build: ${block}`);
  }
}
function linear(values, weights2, bias) {
  const units = bias.length;
  const out = new Float32Array(bias);
  for (let index = 0; index < values.length; index += 1) {
    const value2 = values[index];
    if (value2 === 0) continue;
    const base = index * units;
    for (let unit = 0; unit < units; unit += 1) out[unit] += value2 * weights2[base + unit];
  }
  return out;
}
function relu(values) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] < 0) values[index] = 0;
  }
  return values;
}
function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

// ../amath-bot-lab/src/nn/value.ts
var ValueHead = class {
  #model;
  #cache = /* @__PURE__ */ new Map();
  #limit;
  #hits = 0;
  #misses = 0;
  constructor(model, options = {}) {
    this.#model = model;
    this.#limit = options.cacheLimit ?? 4096;
  }
  get model() {
    return this.#model;
  }
  get stats() {
    return { hits: this.#hits, misses: this.#misses, entries: this.#cache.size };
  }
  /** The history window the artifact was trained with. Observations must match it. */
  get historyWindow() {
    return this.#model.meta.historyWindow ?? DEFAULT_HISTORY_WINDOW;
  }
  evaluate(query) {
    const history = query.history ?? [];
    const encoded = this.encode(query.state, query.side, history);
    const key = encodedObservationDigest(encoded);
    const hit = this.#cache.get(key);
    if (hit !== void 0) {
      this.#hits += 1;
      return { ...hit, historyDepth: Math.min(history.length, this.historyWindow), cached: true };
    }
    this.#misses += 1;
    const reading2 = this.evaluateEncoded(encoded);
    if (this.#cache.size >= this.#limit) this.#cache.clear();
    this.#cache.set(key, { probability: reading2.probability, logit: reading2.logit });
    return {
      ...reading2,
      historyDepth: Math.min(history.length, this.historyWindow),
      cached: false
    };
  }
  /** The same reading, from an observation the caller already encoded. */
  evaluateEncoded(encoded) {
    const input = modelInput(this.#model, encoded);
    const probability = winProbability(this.#model, input);
    return {
      probability,
      logit: Math.log(probability / (1 - probability)),
      historyDepth: encoded.historyWindow,
      cached: false
    };
  }
  /** The Stage 4 encoding of a position, at the window the artifact expects. */
  encode(state, side, history) {
    return encodeObservation(
      observe(state, {
        ...side === void 0 ? {} : { side },
        history,
        historyWindow: this.historyWindow
      })
    );
  }
};

// service/stage5b/entry.ts
var modelDir = fileURLToPath(new URL(".", import.meta.url));
var meta = JSON.parse(readFileSync(resolve(modelDir, "model.json"), "utf8"));
var weights = readFileSync(resolve(modelDir, "weights.bin"));
var bytes = weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength);
var value = new ValueHead(loadValueModel(meta, bytes));
function run(request) {
  const manifest = createManifest();
  const available = /* @__PURE__ */ new Map();
  for (const tile of manifest.tiles) {
    const copies = available.get(tile.kind) ?? [];
    copies.push(tile.id);
    available.set(tile.kind, copies);
  }
  const take = (kind) => {
    const id = available.get(kind)?.shift();
    if (!id) throw new Error(`tile inventory exceeded: ${kind}`);
    return id;
  };
  const board = Array.from({ length: 225 }, () => null);
  for (const cell of request.board) {
    const index = cell.r * 15 + cell.c;
    if (index < 0 || index >= 225 || board[index]) throw new Error("invalid board cell");
    board[index] = {
      tileId: take(cell.kind),
      kind: cell.kind,
      face: cell.token === "x" ? "\xD7" : cell.token === "/" ? "\xF7" : cell.token,
      side: cell.by ?? "A",
      turn: cell.placedTurn ?? 1
    };
  }
  const rack = request.rack.map(take);
  const unseen = manifest.tiles.map((tile) => tile.id).filter((id) => available.get(manifest.kindOf.get(id))?.includes(id));
  if (unseen.length !== request.bagCount + request.oppRackCount) {
    throw new Error("unseen tile count does not match position");
  }
  const opponentRack = unseen.slice(0, request.oppRackCount);
  const bag = unseen.slice(request.oppRackCount);
  const noScoreTail = Array.from(
    { length: Math.min(6, request.noScoreStreak) },
    (_, i) => i % 2 === request.noScoreStreak % 2 ? "A" : "B"
  );
  const state = envStateFrom({
    manifest,
    board,
    racks: { A: rack, B: opponentRack },
    bag,
    scores: { A: request.myScore, B: request.oppScore },
    activeSide: "A",
    turnNumber: request.turnNumber ?? 1,
    noScoreTail,
    hasPlacement: request.board.length > 0,
    seed: request.seed
  });
  const enumerated = enumerateActions(state);
  const actionSet = request.exchangeAllowed ? enumerated : { ...enumerated, exchange: [] };
  if (actionSet.truncated) throw new Error("Stage 5B move generation was incomplete");
  const context = {
    state,
    legal: [...actionSet.place, ...actionSet.exchange, ...actionSet.pass ? [actionSet.pass] : []],
    actionSet,
    side: "A",
    ply: 0,
    turnNumber: state.turnNumber,
    random: decisionRandom(request.seed, "A", 0),
    history: []
  };
  const config = {
    ...DEFAULT_BOT_CONFIG,
    budget: { ...DEFAULT_BOT_CONFIG.budget, deepTop: 64, keepCandidates: Math.max(24, request.topN ?? 24) }
  };
  const decision = decide(context, { value, config });
  const toMove = (candidate) => ({
    type: candidate.family,
    placements: candidate.action.type === "place" ? candidate.action.placements.map((p) => ({ r: Math.floor(p.cell / 15), c: p.cell % 15, kind: p.kind, token: p.face })) : [],
    exchange: candidate.action.type === "exchange" ? [...candidate.action.kinds] : [],
    score: candidate.immediateScore
  });
  const candidates = decision.candidates.slice(0, request.topN ?? 24).map((candidate) => ({
    ...toMove(candidate),
    value: candidate.value,
    chosen: candidate.id === decision.chosen?.id,
    scoreComp: candidate.immediateScore,
    leave: 0,
    potential: 0,
    oppReply: 0,
    mean: candidate.value,
    stddev: 0,
    deep: candidate.deep,
    components: candidate.components.map(({ name, points }) => ({ name, points }))
  }));
  const chosen = candidates.find((candidate) => candidate.chosen) ?? candidates[0];
  if (!chosen) throw new Error("Stage 5B reported no legal action");
  return {
    ...toMove(decision.chosen ?? decision.candidates[0]),
    equity: chosen.value,
    solver: "stage5b",
    endgameSolved: false,
    candidates,
    stats: {
      moves: decision.trace.legal.place + decision.trace.legal.exchange + decision.trace.legal.pass,
      nodes: decision.trace.generator.nodes,
      elapsedMs: decision.trace.timings.totalMs,
      candidates: decision.trace.legal.place + decision.trace.legal.exchange + decision.trace.legal.pass,
      samples: 0,
      depth: 64
    }
  };
}
try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(JSON.stringify(run(JSON.parse(input))) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
}
