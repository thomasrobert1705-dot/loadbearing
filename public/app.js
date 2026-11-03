import { Scene3D, GRID } from './render.js';
import { buildModel, pieceSlot, upgradeDesign } from './engine/model.js';
import { MATERIALS, MATERIAL_IDS, CELL, STOREY, LOAD_DEFAULTS } from './engine/materials.js';
import { PRESETS } from './engine/presets.js';
import { CHALLENGES, loadCases, score, measure, REQ_TEXT } from './engine/challenges.js';
import { MODES } from './engine/solver.js';

const $ = (s) => document.querySelector(s);
const fmtCache = {};
const fmt = (v, d = 0) => (fmtCache[d] ??= new Intl.NumberFormat('en-ZA', { minimumFractionDigits: d, maximumFractionDigits: d })).format(v);
const rand = () => Math.random().toString(36).slice(2);
const MAX_STOREYS = 6;
const STORE_KEY = 'loadbearing.v1';

// ---------------------------------------------------------------------------------------------
// Static tables

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
const TOOLS = [
  { id: 'inspect', label: 'Inspect', icon: svg('<path d="M6 3l12 7-5.5 1.6L10 17z"/>'), hint: 'Hover a piece to see how hard it is working. Left-drag orbits.' },
  { id: 'column', label: 'Column', icon: svg('<rect x="9" y="3" width="6" height="18" rx="1"/><path d="M7 21h10M7 3h10"/>'), hint: 'Click a grid point to stand a column on this storey.' },
  { id: 'beam', label: 'Beam', icon: svg('<rect x="2" y="9" width="20" height="6" rx="1"/><path d="M5 15v4M19 15v4"/>'), hint: 'Click a grid edge, or drag along a grid line. Beams sit at the top of the storey.' },
  { id: 'wall', label: 'Wall', icon: svg('<rect x="3" y="5" width="18" height="14"/><path d="M3 9.7h18M3 14.3h18M9 5v4.7M15 5v4.7M6 9.7v4.6M12 9.7v4.6M18 9.7v4.6M9 14.3V19M15 14.3V19"/>'), hint: 'Click a grid edge, or drag along a grid line for a run of wall panels.' },
  { id: 'window', label: 'Window', icon: svg('<rect x="3" y="4" width="18" height="16"/><rect x="7.5" y="8" width="9" height="7"/><path d="M12 8v7M7.5 11.5h9"/>'), hint: 'Drag along a wall as far as you like (1 m = two grid squares); it replaces that stretch with one continuous window. The wall above has to span the gap: brick manages about 2 m, so put a beam (lintel) or columns over a longer one.' },
  { id: 'door', label: 'Door', icon: svg('<rect x="3" y="3" width="18" height="18"/><rect x="9" y="9" width="6.5" height="12"/><circle cx="14" cy="15" r="0.6"/>'), hint: 'Drag along a wall over about 1 m (two grid squares) for a door; it replaces that stretch of wall. Big opening, much weaker against racking.' },
  { id: 'brace', label: 'Brace', icon: svg('<rect x="3" y="3" width="18" height="18"/><path d="M3 3l18 18M21 3 3 21"/>'), hint: 'Cross bracing for an open bay. Needs columns at both ends. It turns a wobbly frame into a stiff one.' },
  { id: 'slab', label: 'Floor', icon: svg('<path d="M2 14l5-5h15l-5 5z"/><path d="M2 14v2.5h15V14M17 16.5l5-5V9"/>'), hint: 'Click a cell or drag a rectangle. Places the floor you stand on at this level: a ground slab on the ground floor, an upper floor (resting on the walls below) higher up.' },
  { id: 'roof', label: 'Roof', icon: svg('<path d="M2 12.5 12 5l10 7.5"/><path d="M5 10.5V20h14v-9.5"/>'), hint: 'Drag a rectangle over your walls for a roof. H switches gable / hip, R turns the ridge.' },
  { id: 'erase', label: 'Erase', icon: svg('<path d="M4 15.5 13 6.5l5.5 5.5-6.5 6.5H7z"/><path d="M8.5 11l5.5 5.5M11 19h9"/>'), hint: 'Click or drag over pieces to remove them.' },
];
const TYPE_NAMES = { column: 'Column', beam: 'Beam', wall: 'Wall', window: 'Window wall', door: 'Door wall', brace: 'Cross bracing', slab: 'Floor', roof: 'Roof' };
const MODE_TEXT = ['fine', 'pulled apart (tension)', 'crushed', 'buckled', 'cracked in bending', 'sheared', 'lost stability', 'tie-down pulled out'];
const MODE_SHORT = ['', 'tension', 'crushing', 'buckling', 'bending', 'shear', 'instability', 'uplift'];
const storeyName = (s) => (s === 0 ? 'ground floor' : `${s}${['st', 'nd', 'rd'][s - 1] || 'th'} floor`);
const pieceStoreyLabel = (p) => (p.type === 'slab' ? (p.s < 0 ? 'ground slab' : `floor of ${storeyName(p.s + 1)}`) : p.type === 'beam' ? `top of ${storeyName(p.s)}` : p.type === 'roof' ? `on ${storeyName(p.s)}` : storeyName(p.s));
// "9 m of window wall", "4 m² of floor", "3 columns": how much of a kind of piece there is.
const LINEAR_TYPES = new Set(['wall', 'window', 'door', 'beam', 'brace']);
const qtyFmt = (v) => fmt(v, Number.isInteger(v) ? 0 : Number.isInteger(v * 10) ? 1 : 2);
const typeName = (p) => (p.type === 'roof' ? (p.style === 'hip' ? 'Hip roof' : 'Gable roof') : TYPE_NAMES[p.type]);
function amountOf(type, n) {
  const name = TYPE_NAMES[type].toLowerCase();
  if (LINEAR_TYPES.has(type)) return `${qtyFmt(n * CELL)} m of ${name}`;
  if (type === 'slab') return `${qtyFmt(n * CELL * CELL)} m² of floor`;
  if (type === 'roof') return n > 1 ? `${n} roofs` : 'roof';
  return n > 1 ? `${n} ${name}s` : name;
}
const compass = (deg) => ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const SCENARIOS = [
  { id: 'custom', name: 'Custom' },
  { id: 'everyday', name: 'An ordinary day', loads: { live: 1.5, snow: 0, wind: 0, quake: 0 } },
  { id: 'party', name: 'Packed party on every floor', loads: { live: 5, snow: 0, wind: 0, quake: 0 } },
  { id: 'highveld', name: 'Highveld thunderstorm (30 m/s)', loads: { live: 0.5, snow: 0, wind: 30, quake: 0 } },
  { id: 'cape', name: 'Cape of Storms gale (40 m/s)', loads: { live: 0.5, snow: 0, wind: 40, quake: 0 } },
  { id: 'cyclone', name: 'Category 4 cyclone (65 m/s)', loads: { live: 0.5, snow: 0, wind: 65, quake: 0 } },
  { id: 'tornado', name: 'EF4 tornado (85 m/s)', loads: { live: 0.5, snow: 0, wind: 85, quake: 0 } },
  { id: 'snow', name: 'Drakensberg blizzard (2.5 kPa snow)', loads: { live: 0.5, snow: 2.5, wind: 15, quake: 0 } },
  { id: 'tulbagh', name: 'Tulbagh 1969 earthquake (≈0.25 g)', loads: { live: 0.5, snow: 0, wind: 0, quake: 0.25 } },
  { id: 'strongquake', name: 'Strong earthquake (0.5 g)', loads: { live: 0.5, snow: 0, wind: 0, quake: 0.5 } },
  { id: 'extremequake', name: 'Extreme earthquake (1 g)', loads: { live: 0.5, snow: 0, wind: 0, quake: 1 } },
];

// ---------------------------------------------------------------------------------------------
// State

const state = {
  mode: 'build',
  tool: 'inspect',
  mat: 'brick',
  storey: 0,
  roofAxis: 'auto',
  roofStyle: 'gable',
  challenge: null,
  roofPitch: 30,
  design: null,
  loads: { ...LOAD_DEFAULTS, windDir: 0, quakeDir: 0 },
  scenario: 'everyday',
  fadeAbove: true,
  deadStress: false,
  undo: [],
  redo: [],
  model: null,
  check: null,
  test: null,
  exag: 100,
  colorBy: 'stress',
  plTool: false,
  hoverPart: null,
};

function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s?.design?.pieces) {
      state.design = upgradeDesign(s.design);
      Object.assign(state.loads, s.loads || {});
      if (s.mat && MATERIALS[s.mat]) state.mat = s.mat;
      if (s.scenario) state.scenario = s.scenario;
      if (CHALLENGES.some((c) => c.id === s.challenge)) state.challenge = s.challenge;
      return;
    }
  } catch { /* storage unavailable: start fresh */ }
  state.design = PRESETS[0].design();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ design: state.design, loads: state.loads, mat: state.mat, scenario: state.scenario, challenge: state.challenge })); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------
// Worker

const worker = new Worker('./worker.js', { type: 'module' });
let reqSeq = 0;
const pending = new Map();
const latest = {};
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  pending.delete(data.id);
  if (!p) return;
  if (data.error) { console.error(data.error); p.reject(new Error(data.error)); } else p.resolve(data);
};
function analyse(kind, payload) {
  const id = ++reqSeq;
  latest[kind] = id;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, kind, ...payload });
  }).then((r) => (latest[kind] === id ? r : null));
}

// ---------------------------------------------------------------------------------------------
// Scene

const scene = new Scene3D($('#canvasWrap'));
const pieceById = () => new Map(state.design.pieces.map((p) => [p.id, p]));
let pieces = new Map();

function rebuild({ keepCheck = false } = {}) {
  pieces = pieceById();
  state.model = buildModel(state.design, {});
  scene.setModel(state.model, (pid) => pieces.get(pid));
  if (!keepCheck) state.check = null;
  state.test = null;
  hideResults();
  applyStyle();
  updateStats();
  scheduleCheck();
  showPointLoads();
  save();
}

let checkTimer = 0;
function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    const r = await analyse('check', { design: state.design });
    if (!r) return;
    state.check = r;
    updateStatus();
    applyStyle();
    updateStats();
  }, 80);
}

function utilColor(u) {
  // green → yellow → orange → red, matching the legend
  const stops = [[0, [46, 157, 87]], [0.4, [156, 201, 74]], [0.65, [240, 196, 25]], [0.85, [239, 125, 34]], [1, [210, 60, 60]]];
  const x = Math.max(0, Math.min(1, u));
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1][0]) i++;
  const [a, ca] = stops[i], [b, cb] = stops[i + 1];
  const t = (x - a) / (b - a);
  const c = ca.map((v, k) => Math.round(v + (cb[k] - v) * t));
  return (c[0] << 16) | (c[1] << 8) | c[2];
}

function isFaded(piece) {
  if (!state.fadeAbove || state.mode !== 'build' || !piece) return false;
  if (piece.s > state.storey) return true;
  if (piece.type === 'roof' && piece.s >= state.storey && !['roof', 'inspect', 'erase'].includes(state.tool)) return true;
  return false;
}

// "Pulling vs squashing": blue for members in tension, red for compression, stronger the more
// stressed they are relative to the most stressed member in view (so load paths show up even
// under small loads). Each part shows its most stressed member.
const forceCache = new WeakMap();
const TENSION = [47, 111, 214], SQUASH = [214, 69, 47], NEUTRAL = [222, 217, 204];
function forceColors(f) {
  if (forceCache.has(f)) return forceCache.get(f);
  const { elems, parts } = state.model;
  const sig = new Float32Array(elems.length);
  let max = 1e-9;
  elems.forEach((e, k) => {
    if (!f.active[k] && f.active.length) return;
    sig[k] = (f.elemN?.[k] || 0) / e.sec.A;
    max = Math.max(max, Math.abs(sig[k]));
  });
  const out = parts.map((pt) => {
    let best = 0;
    for (const e of pt.elems) if (Math.abs(sig[e]) > Math.abs(best)) best = sig[e];
    const t = Math.sqrt(Math.abs(best) / max), to = best >= 0 ? TENSION : SQUASH;
    const c = NEUTRAL.map((v, d) => Math.round(v + (to[d] - v) * t));
    return (c[0] << 16) | (c[1] << 8) | c[2];
  });
  forceCache.set(f, out);
  return out;
}
const partColor = (f, i) => (state.colorBy === 'force' ? forceColors(f)[i] : utilColor(f.partUtil[i]));

function applyStyle() {
  const hoverPiece = state.hoverPart != null ? state.model.parts[state.hoverPart]?.piece : null;
  const T = state.test, P = play;
  scene.styleParts((i) => {
    const part = state.model.parts[i];
    const piece = pieces.get(part.piece);
    const s = {};
    if (state.mode === 'test' && T) {
      const f = T.frames[P.idx];
      if (P.hidden.has(i)) return { hidden: true };
      if (state.colorBy !== 'none') s.color = partColor(f, i);
      s.damaged = part.elems.some((e) => !f.active[e]);
    } else if (state.mode === 'test') {
      if (state.colorBy !== 'none' && state.check) s.color = partColor(state.check.frames.at(-1), i);
    } else {
      const ck = state.check?.frames.at(-1);
      if (state.deadStress && ck) s.color = partColor(ck, i);
      if (ck && state.check.frames.some((f) => f.fell.includes(i))) { s.color = 0xe04040; s.glow = 0x550000; }
      if (isFaded(piece)) s.opacity = 0.12;
    }
    if (hoverPiece != null && part.piece === hoverPiece) s.glow = state.tool === 'erase' && state.mode === 'build' ? 0x770000 : 0x244d34;
    return s;
  });
}

// ---------------------------------------------------------------------------------------------
// Build tools

function planeY() {
  return ['beam', 'roof'].includes(state.tool) ? (state.storey + 1) * STOREY : state.storey * STOREY;
}
const inGridPt = (i, j) => i >= -GRID && i <= GRID && j >= -GRID && j <= GRID;

function edgeAt(p) {
  const fx = p.x / CELL, fz = p.z / CELL;
  const rx = Math.round(fx), rz = Math.round(fz);
  if (Math.abs(fz - rz) < Math.abs(fx - rx)) { const i = Math.floor(fx); return { i1: i, j1: rz, i2: i + 1, j2: rz }; }
  const j = Math.floor(fz);
  return { i1: rx, j1: j, i2: rx, j2: j + 1 };
}
const gridPt = (p) => ({ i: Math.round(p.x / CELL), j: Math.round(p.z / CELL) });
const cellAt = (p) => ({ i: Math.floor(p.x / CELL), j: Math.floor(p.z / CELL) });

// Pieces the current tool would place, given the hover point and (optional) drag start.
function candidates(p, start) {
  const t = state.tool, s = state.storey, mat = state.mat;
  const out = [];
  if (t === 'column') {
    const g = gridPt(p);
    out.push({ type: 'column', mat, i: g.i, j: g.j, s });
  } else if (['beam', 'wall', 'window', 'door', 'brace'].includes(t)) {
    if (start && start.moved) {
      const a = start.grid, b = gridPt(p);
      if (Math.abs(b.i - a.i) >= Math.abs(b.j - a.j)) {
        const [lo, hi] = [Math.min(a.i, b.i), Math.max(a.i, b.i)];
        for (let i = lo; i < hi; i++) out.push({ type: t, mat, i1: i, j1: a.j, i2: i + 1, j2: a.j, s });
      } else {
        const [lo, hi] = [Math.min(a.j, b.j), Math.max(a.j, b.j)];
        for (let j = lo; j < hi; j++) out.push({ type: t, mat, i1: a.i, j1: j, i2: a.i, j2: j + 1, s });
      }
    } else {
      out.push({ type: t, mat, ...edgeAt(p), s });
    }
  } else if (t === 'slab' || t === 'roof') {
    const a = start ? start.cell : cellAt(p), b = cellAt(p);
    const i0 = Math.min(a.i, b.i), i1 = Math.max(a.i, b.i), j0 = Math.min(a.j, b.j), j1 = Math.max(a.j, b.j);
    if (t === 'slab') {
      // A slab is stored as the top of the storey below it, so the floor of storey s is slab s − 1.
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push({ type: 'slab', mat, i, j, s: s - 1 });
    } else {
      const di = i1 - i0 + 1, dj = j1 - j0 + 1;
      const axis = state.roofAxis === 'auto' ? (di >= dj ? 'x' : 'z') : state.roofAxis;
      out.push({ type: 'roof', mat, i0, j0, i1: i1 + 1, j1: j1 + 1, s, axis, pitch: state.roofPitch, style: state.roofStyle });
    }
  }
  return out;
}

function validPiece(c) {
  if (c.s < (c.type === 'slab' ? -1 : 0) || c.s >= MAX_STOREYS) return false;
  if (c.type === 'column') return inGridPt(c.i, c.j);
  if (c.type === 'slab') return inGridPt(c.i, c.j) && inGridPt(c.i + 1, c.j + 1);
  if (c.type === 'roof') return inGridPt(c.i0, c.j0) && inGridPt(c.i1, c.j1);
  return inGridPt(c.i1, c.j1) && inGridPt(c.i2, c.j2);
}

function ghostFor(cands) {
  if (!cands.length) return scene.setGhost(null);
  const ok = cands.every(validPiece);
  const m = buildModel({ pieces: cands.map((c, k) => ({ ...c, id: -1 - k })), pointLoads: [] }, {});
  const P = (id) => [m.nodes[id].x, m.nodes[id].y, m.nodes[id].z];
  // The ghost is see-through, so draw each panel as one block rather than a stack of 0.5 m slices
  // (whose touching sides would show through as a grid of lines). Slices of the same panel and
  // look are merged when they're side by side.
  const prims = [], groups = new Map();
  for (const part of m.parts) for (const pr of part.prims) {
    if (pr.t === 'bar') { prims.push({ ...pr, a: P(pr.a), b: P(pr.b) }); continue; }
    if (pr.t !== 'quad') { prims.push({ ...pr, c: pr.c.map(P) }); continue; }
    const key = [pr.c.join(','), pr.look, pr.thick, pr.offset, pr.horizontal ? '' : `${pr.uv[2]},${pr.uv[3]}`].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pr);
  }
  for (const list of groups.values()) {
    const base = list[0];
    if (base.horizontal) {
      const uv = [Math.min(...list.map((p) => p.uv[0])), Math.max(...list.map((p) => p.uv[1])), Math.min(...list.map((p) => p.uv[2])), Math.max(...list.map((p) => p.uv[3]))];
      prims.push({ ...base, uv, c: base.c.map(P) });
      continue;
    }
    list.sort((a, b) => a.uv[0] - b.uv[0]);
    let cur = [...base.uv];
    for (const p of list.slice(1)) {
      if (p.uv[0] <= cur[1] + 1e-6) cur[1] = Math.max(cur[1], p.uv[1]);
      else { prims.push({ ...base, uv: cur, c: base.c.map(P) }); cur = [...p.uv]; }
    }
    prims.push({ ...base, uv: cur, c: base.c.map(P) });
  }
  scene.setGhost(prims, MATERIALS[state.mat].color, ok);
}

function snapshot() {
  state.undo.push(JSON.stringify(state.design));
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
  updateUndo();
}
function nextId() { return state.design.pieces.reduce((m, p) => Math.max(m, p.id), 0) + 1; }

function place(cands) {
  cands = cands.filter(validPiece);
  if (!cands.length) return;
  const slots = new Map(state.design.pieces.map((p) => [pieceSlot(p), p]));
  const changes = cands.filter((c) => {
    const ex = slots.get(pieceSlot(c));
    return !ex || ex.type !== c.type || ex.mat !== c.mat || (c.type === 'roof' && (ex.axis !== c.axis || ex.pitch !== c.pitch || (ex.style || 'gable') !== c.style));
  });
  if (!changes.length) return;
  snapshot();
  const kill = new Set(changes.map(pieceSlot));
  // A new roof replaces any roof it overlaps on the same storey.
  const overlaps = (a, b) => a.s === b.s && a.i0 < b.i1 && b.i0 < a.i1 && a.j0 < b.j1 && b.j0 < a.j1;
  state.design.pieces = state.design.pieces.filter((p) =>
    !kill.has(pieceSlot(p)) && !(p.type === 'roof' && changes.some((c) => c.type === 'roof' && overlaps(p, c))));
  let id = nextId();
  for (const c of changes) state.design.pieces.push({ id: id++, ...c });
  rebuild();
}

function erasePiece(pid) {
  if (pid == null) return;
  snapshot();
  state.design.pieces = state.design.pieces.filter((p) => p.id !== pid);
  state.hoverPart = null;
  rebuild();
}

// ---------------------------------------------------------------------------------------------
// Pointer handling

const canvas = scene.renderer.domElement;
let drag = null;
let lastPointer = null;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (state.mode === 'test') {
    if (state.plTool) addPointLoadAt(e.clientX, e.clientY);
    return;
  }
  if (state.tool === 'inspect' || state.panel === 'challenges') return;
  if (state.tool === 'erase') {
    drag = { erase: true, erased: new Set() };
    const part = scene.pickPart(e.clientX, e.clientY);
    if (part != null) { drag.erased.add(state.model.parts[part].piece); erasePiece(state.model.parts[part].piece); }
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  const p = scene.rayToPlane(e.clientX, e.clientY, planeY());
  if (!p) return;
  drag = { x: e.clientX, y: e.clientY, grid: gridPt(p), cell: cellAt(p), moved: false };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  onHover(e.clientX, e.clientY);
});

function onHover(x, y) {
  if (state.mode === 'test') {
    if (state.plTool) return hoverNode(x, y);
    return hoverInspect(x, y);
  }
  if (state.tool === 'inspect' || state.panel === 'challenges') return hoverInspect(x, y);
  if (state.tool === 'erase') {
    const part = scene.pickPart(x, y);
    if (drag?.erase && part != null) {
      const pid = state.model.parts[part].piece;
      if (!drag.erased.has(pid)) { drag.erased.add(pid); erasePiece(pid); return; }
    }
    setHoverPart(part);
    showTipForPart(part, x, y);
    return;
  }
  hideTip();
  const p = scene.rayToPlane(x, y, planeY());
  if (!p) return scene.setGhost(null);
  if (drag && !drag.erase && Math.hypot(x - drag.x, y - drag.y) > 6) drag.moved = true;
  ghostFor(candidates(p, drag));
}

canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !drag) return;
  const d = drag;
  drag = null;
  if (d.erase) return;
  const p = scene.rayToPlane(e.clientX, e.clientY, planeY());
  if (p) place(candidates(p, d));
  onHover(e.clientX, e.clientY);
});
canvas.addEventListener('pointerleave', () => { if (!drag) { scene.setGhost(null); setHoverPart(null); hideTip(); } });

function setHoverPart(part) {
  if (state.hoverPart === part) return;
  state.hoverPart = part;
  applyStyle();
}

// ---------------------------------------------------------------------------------------------
// Tooltips

const tip = $('#tip');
function hideTip() { tip.hidden = true; }
function hoverInspect(x, y) {
  const part = scene.pickPart(x, y);
  setHoverPart(part);
  showTipForPart(part, x, y);
}
function showTipForPart(part, x, y) {
  if (part == null) return hideTip();
  const pt = state.model.parts[part];
  const piece = pieces.get(pt.piece);
  if (!piece) return hideTip();
  let html = `<b>${typeName(piece)} · ${matName(piece).replace(/^./, (c) => c.toUpperCase())}</b><span class="muted">${pieceStoreyLabel(piece)}</span>`;
  let u = null, mode = 0, label = 'Stress from self-weight';
  if (state.mode === 'test' && state.test) {
    const f = state.test.frames[play.idx];
    u = f.partUtil[part]; mode = f.partMode[part];
    label = `Stress at ${fmt(f.lam * 100)}% load`;
    if (pt.elems.some((e) => !f.active[e])) html += `<div style="color:var(--bad)">Damaged</div>`;
  } else if (state.check) {
    const f = state.check.frames.at(-1);
    u = f.partUtil[part]; mode = f.partMode[part];
    if (state.check.frames.some((fr) => fr.fell.includes(part))) html += `<div style="color:var(--bad)">Nothing holds this up</div>`;
  }
  if (u != null) {
    const col = '#' + utilColor(u).toString(16).padStart(6, '0');
    html += `<div class="bar"><i style="width:${Math.min(100, u * 100)}%;background:${col}"></i></div>${label}: <b style="display:inline">${fmt(u * 100)}%</b>${u > 0.05 && mode ? ` (${MODE_SHORT[mode]})` : ''}`;
  }
  if (state.tool === 'erase' && state.mode === 'build') html += `<div class="muted">Click to remove</div>`;
  tip.innerHTML = html;
  tip.hidden = false;
  const r = $('#stage').getBoundingClientRect();
  tip.style.left = Math.min(x - r.left + 16, r.width - 290) + 'px';
  tip.style.top = Math.min(y - r.top + 14, r.height - 110) + 'px';
}

// ---------------------------------------------------------------------------------------------
// Point loads

const PL_DIRS = { down: [0, -1, 0], up: [0, 1, 0], E: [1, 0, 0], W: [-1, 0, 0], S: [0, 0, 1], N: [0, 0, -1] };
let plHoverNode = null;

function loadableNodes() {
  return state.model.nodes.map((n, i) => ({ ...n, i })).filter((n) => !n.fixed);
}
function hoverNode(x, y) {
  let best = null, bd = 18;
  for (const n of loadableNodes()) {
    const [sx, sy, z] = scene.toScreen([n.x, n.y, n.z]);
    if (z > 1) continue;
    const d = Math.hypot(sx - x, sy - y);
    if (d < bd) { bd = d; best = n; }
  }
  plHoverNode = best;
  hideTip();
  if (best) {
    const dir = PL_DIRS[$('#plDir').value];
    const mag = +$('#plMag').value || 0;
    const ghost = { x: best.x, y: best.y, z: best.z, fx: dir[0] * mag, fy: dir[1] * mag, fz: dir[2] * mag };
    showPointLoads([ghost]);
  } else showPointLoads();
}
function addPointLoadAt(x, y) {
  hoverNode(x, y);
  if (!plHoverNode) return;
  const dir = PL_DIRS[$('#plDir').value];
  const mag = Math.max(0, +$('#plMag').value || 0);
  if (!mag) return;
  snapshot();
  const n = plHoverNode;
  state.design.pointLoads = state.design.pointLoads || [];
  state.design.pointLoads.push({ id: rand(), x: n.x, y: n.y, z: n.z, fx: dir[0] * mag, fy: dir[1] * mag, fz: dir[2] * mag });
  save();
  resetTest();
  renderPointLoadList();
  showPointLoads();
}
function showPointLoads(extra = []) {
  const list = state.mode === 'test' ? [...(state.design.pointLoads || []), ...extra] : [];
  const idx = state.model?.nodeIndex;
  const posFn = (pl) => {
    const id = idx?.get(state.model.nodeKey(pl.x, pl.y, pl.z));
    return id != null && scene.posFn ? scene.posFn(id) : [pl.x, pl.y, pl.z];
  };
  scene.showPointLoads(list, posFn);
  scene.showNodeMarkers(state.mode === 'test' && state.plTool ? loadableNodes().map((n) => [n.x, n.y, n.z]) : []);
}
function renderPointLoadList() {
  const ul = $('#plList');
  const list = state.design.pointLoads || [];
  ul.innerHTML = '';
  for (const pl of list) {
    const mag = Math.hypot(pl.fx, pl.fy, pl.fz);
    const dirName = pl.fy < 0 ? 'down' : pl.fy > 0 ? 'up' : pl.fx > 0 ? 'east' : pl.fx < 0 ? 'west' : pl.fz > 0 ? 'south' : 'north';
    const attached = state.model.nodeIndex.has(state.model.nodeKey(pl.x, pl.y, pl.z));
    const li = document.createElement('li');
    li.innerHTML = `<span>${fmt(mag)} kN ${dirName} at (${fmt(pl.x)}; ${fmt(pl.z)}) h ${fmt(pl.y)} m${attached ? '' : ' <em style="color:var(--bad)">not attached</em>'}</span><button title="Remove">✕</button>`;
    li.querySelector('button').onclick = () => {
      snapshot();
      state.design.pointLoads = list.filter((x) => x !== pl);
      save(); resetTest(); renderPointLoadList(); showPointLoads();
    };
    ul.appendChild(li);
  }
  if (!list.length) ul.innerHTML = '<li class="note" style="background:none">None yet. Turn on placing, then click a joint.</li>';
}

// ---------------------------------------------------------------------------------------------
// Test runs and playback

const play = { t: 0, playing: false, idx: 0, shown: 0, hidden: new Set(), cum: [], total: 0, shakeT: 0 };

async function runTest(push) {
  if (!state.design.pieces.length) return;
  $('#busy').hidden = false;
  $('#runBtn').disabled = $('#pushBtn').disabled = true;
  try {
    const r = await analyse('test', { design: state.design, loads: state.loads, push });
    if (!r) return;
    startPlayback(r, push, state.loads);
  } catch (err) {
    alert('Analysis failed: ' + err.message);
  } finally {
    $('#busy').hidden = true;
    $('#runBtn').disabled = $('#pushBtn').disabled = false;
  }
}

function startPlayback(r, push, loads) {
  {
    state.test = { ...r, push, loads: { ...loads } };
    // Frame timing: load steps are quick, failures linger so you can see them.
    let t = 0;
    play.cum = r.frames.map((f, i) => {
      const start = t;
      t += i === 0 ? 0.6 : f.failed.length || f.fell.length ? 0.55 : r.frames.length > 60 ? 0.06 : 0.1;
      return start;
    });
    play.total = t + 0.4;
    play.fallenAt = new Map();
    r.frames.forEach((f, k) => f.fell.forEach((p) => { if (!play.fallenAt.has(p)) play.fallenAt.set(p, k); }));
    autoExaggeration();
    seek(0);
    play.playing = true;
    showResults();
    $('#timeline').hidden = false;
    $('#stage').classList.add('has-timeline');
  }
}

function autoExaggeration() {
  const d = state.test.summary.maxDisp || 0.001;
  state.exag = Math.max(1, Math.min(1000, 0.3 / d));
  $('#exag').value = Math.log10(state.exag).toFixed(2);
  $('#exagOut').textContent = '×' + fmt(state.exag);
}

function frameAt(t) {
  const c = play.cum;
  let lo = 0, hi = c.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c[mid] <= t) lo = mid; else hi = mid - 1; }
  return lo;
}

function seek(t) {
  play.t = Math.max(0, Math.min(t, play.total));
  play.idx = frameAt(play.t);
  scene.clearDebris();
  play.hidden = new Set();
  for (const [p, k] of play.fallenAt) if (k <= play.idx) play.hidden.add(p);
  play.shown = play.idx;
  renderFrame();
}

function resetTest() {
  state.test = null;
  play.playing = false;
  scene.clearDebris();
  scene.shakeWorld([0, 0, 0]);
  scene.deform(null, 0);
  hideResults();
  applyStyle();
  showPointLoads();
}

scene.onFrame = (dt) => {
  if (state.mode !== 'test' || !state.test) return;
  if (play.playing) {
    play.t += dt;
    play.shakeT += dt;
    if (play.t >= play.total) { play.t = play.total; play.playing = false; }
    const idx = frameAt(play.t);
    if (idx !== play.idx) {
      const th = (state.test.loads.windDir * Math.PI) / 180;
      const w = Math.min(12, state.test.loads.wind * 0.06 * Math.sqrt(Math.max(1, state.test.frames[idx].lam)));
      for (let k = play.shown + 1; k <= idx; k++) {
        const fell = state.test.frames[k].fell.filter((p) => !play.hidden.has(p));
        if (fell.length) scene.dropParts(fell, [Math.cos(th) * w, 0, Math.sin(th) * w]);
      }
      play.shown = Math.max(play.shown, idx);
      play.idx = idx;
      applyStyle();
      updateTimeline();
    }
  }
  renderFrame(true);
};

function renderFrame(fromTick = false) {
  const T = state.test;
  if (!T) return;
  const f = T.frames[play.idx], g = T.frames[play.idx + 1];
  let U = f.U;
  if (g && g.lam !== f.lam && !g.failed.length) {
    const a = (play.t - play.cum[play.idx]) / Math.max(1e-6, (play.cum[play.idx + 1] ?? play.total) - play.cum[play.idx]);
    U = f.U.map((v, k) => v + (g.U[k] - v) * Math.max(0, Math.min(1, a)));
  }
  // Earthquakes: the ground shakes and the house sways back and forth around its dead-load shape.
  let shake = 1;
  if (T.loads.quake > 0 && play.playing) {
    shake = Math.sin(play.shakeT * 2 * Math.PI * 2.2);
    const th = (T.loads.quakeDir * Math.PI) / 180;
    const a = 0.06 * T.loads.quake * Math.sin(play.shakeT * 2 * Math.PI * 2.2 + 1.2) * Math.min(1, f.lam * 2);
    scene.shakeWorld([Math.cos(th) * a, 0, Math.sin(th) * a]);
  } else scene.shakeWorld([0, 0, 0]);
  scene.deform(U, state.exag, shake, T.loads.quake > 0 ? T.frames[0].U : null);
  showPointLoads();
  if (!fromTick) { applyStyle(); updateTimeline(); }
  else if (play.playing) updateTimeline();
}

function updateTimeline() {
  const T = state.test;
  if (!T) return;
  const f = T.frames[play.idx];
  $('#scrub').value = String(Math.round((play.t / play.total) * 1000));
  const broken = f.active.reduce((a, v) => a + (v ? 0 : 1), 0);
  $('#tlLabel').textContent = `Load ${fmt(f.lam * 100)}%${broken ? ` · ${fmt(broken)} members gone` : ''}`;
  $('#playBtn').textContent = play.playing ? '❚❚' : '▶';
  $('#playBtn').setAttribute('aria-label', play.playing ? 'Pause' : 'Play');
}

// ---------------------------------------------------------------------------------------------
// Results card

const matName = (p) => (p.type === 'roof' && MATERIALS[p.mat].roofName) || MATERIALS[p.mat].name.toLowerCase();
function pieceText(p) {
  return `${typeName(p).toLowerCase()} (${matName(p)}, ${pieceStoreyLabel(p)})`;
}
function describeElem(info) {
  if (!info) return '';
  const p = pieces.get(info.piece);
  if (!p) return `${info.role} ${MODE_TEXT[info.mode]}`;
  const sameAsPiece = info.role === p.type || info.role === TYPE_NAMES[p.type].toLowerCase();
  return sameAsPiece ? `${pieceText(p)} ${MODE_TEXT[info.mode]}` : `${info.role} of a ${pieceText(p)} ${MODE_TEXT[info.mode]}`;
}

function loadsSummary(L) {
  const bits = [];
  if (L.live) bits.push(`${fmt(L.live, 1)} kPa people`);
  if (L.snow) bits.push(`${fmt(L.snow, 2)} kPa snow`);
  if (L.wind) bits.push(`${fmt(L.wind)} m/s wind from ${compass(L.windDir + 180)}`);
  if (L.quake) bits.push(`${fmt(L.quake, 2)} g quake`);
  const pls = (state.design.pointLoads || []).length;
  if (pls) bits.push(`${pls} point load${pls > 1 ? 's' : ''}`);
  return bits.join(' · ') || 'self-weight only';
}

function showResults() {
  const T = state.test, S = T.summary;
  const el = $('#results');
  let cls, title, lead;
  const fell = S.fallenFrac;
  if (T.push) {
    if (!S.hasTest) { cls = 'warn'; title = 'Nothing to push'; lead = 'Add some test loads first: wind, quake, snow, people or point loads.'; }
    else if (S.collapseLam) { cls = 'bad'; title = `Collapses at ${fmt(S.collapseLam, 1)}× these loads`; lead = S.firstDamage ? `First damage at ${fmt(S.firstDamage.lam, 2)}×: ${describeElem(S.firstDamage)}.` : ''; }
    else { cls = S.failedCount ? 'warn' : 'good'; title = `Still standing at ${fmt(S.finalLam, 0)}× these loads${S.failedCount ? ' (damaged)' : ''}`; lead = S.firstDamage ? `First damage at ${fmt(S.firstDamage.lam, 2)}×: ${describeElem(S.firstDamage)}.` : 'Not a scratch. Seriously over-built.'; }
  } else if (fell > 0.5) { cls = 'bad'; title = 'Collapsed'; lead = `${fmt(fell * 100)}% of the house came down.`; }
  else if (fell > 0.001) { cls = 'bad'; title = 'Partial collapse'; lead = `${fmt(fell * 100)}% of the house came down.`; }
  else if (S.failedCount) { cls = 'warn'; title = 'Standing, but damaged'; lead = `${fmt(S.failedCount)} member${S.failedCount > 1 ? 's' : ''} broke and the loads found another way down.`; }
  else {
    cls = 'good'; title = 'Standing';
    const p = S.worst && pieces.get(S.worst.piece);
    lead = p ? `The hardest-working member is at ${fmt(S.worst.util * 100)}% of its strength (${MODE_SHORT[S.worst.mode]}): the ${S.worst.role} of a ${pieceText(p)}.` : '';
  }

  if (!T.push && S.firstDamage && S.failedCount) lead += ` First failure at ${fmt(S.firstDamage.lam * 100)}% of the loads: ${describeElem(S.firstDamage)}.`;

  // One line per piece per load level: what broke in it, and whether (some of) it fell.
  const elemPieces = new Map();
  for (const part of state.model.parts) for (const e of part.elems) {
    if (!elemPieces.has(e)) elemPieces.set(e, new Set());
    elemPieces.get(e).add(part.piece);
  }
  const events = [];
  let group = null;
  const flush = () => {
    if (!group) return;
    // Identical lines (e.g. a whole wall of 0.5 m pieces cracking the same way) collapse into
    // one, with the amount given as a length, an area or a count.
    const lines = new Map();
    for (const [pid, v] of group.byPiece) {
      const p = pieces.get(pid);
      if (!p) continue;
      const modes = [...v.modes].filter(Boolean).map((m) => MODE_TEXT[m]);
      const how = [modes.join(', '), v.fell ? (p.type === 'roof' ? 'parts came off' : 'fell') : ''].filter(Boolean).join(' → ');
      const key = `${p.type}|${matName(p)}|${pieceStoreyLabel(p)}|${how || 'damaged'}`;
      lines.set(key, (lines.get(key) || 0) + 1);
    }
    for (const [key, n] of lines) {
      const [type, mat, where, how] = key.split('|');
      const what = amountOf(type, n);
      events.push({ k: group.k, html: `<b>${T.push ? fmt(group.lam, 2) + '×' : fmt(group.lam * 100) + '%'}</b> ${what.replace(/^./, (c) => c.toUpperCase())} (${mat}, ${where}): ${how}` });
    }
    group = null;
  };
  T.frames.forEach((f, k) => {
    if (!f.failed.length && !f.fell.length) return;
    if (!group || Math.abs(group.lam - f.lam) > 1e-3) { flush(); group = { k, lam: f.lam, byPiece: new Map() }; }
    const get = (pid) => {
      if (!group.byPiece.has(pid)) group.byPiece.set(pid, { modes: new Set(), fell: false });
      return group.byPiece.get(pid);
    };
    // A broken member belongs to a whole panel, so every piece in that panel shares the damage.
    f.failed.forEach((e, n) => {
      for (const pid of elemPieces.get(e) || [state.model.elems[e].piece]) get(pid).modes.add(f.failedModes?.[n] || 0);
    });
    for (const p of f.fell) get(state.model.parts[p].piece).fell = true;
  });
  flush();

  el.innerHTML = `
    <h3 class="${cls}">${title}</h3>
    <p>${lead}</p>
    <div class="kv">
      <span>Loads</span><span>${loadsSummary(T.loads)}</span>
      <span>Biggest movement</span><span>${fmt(S.maxDisp * 1000, S.maxDisp < 0.01 ? 1 : 0)} mm</span>
      <span>Members broken</span><span>${fmt(S.failedCount)}</span>
      <span>Weight</span><span>${fmt(T.totals.mass / 1000, 1)} t</span>
      <span>Analysis time</span><span>${fmt(T.ms)} ms · ${fmt(T.frames.length)} steps</span>
    </div>
    ${events.length ? `<div class="note">What happened (click to jump):</div><ol>${events.slice(0, 120).map((e) => `<li data-k="${e.k}">${e.html}</li>`).join('')}</ol>` : ''}
  `;
  el.querySelectorAll('li[data-k]').forEach((li) => {
    li.onclick = () => { play.playing = false; seek(play.cum[+li.dataset.k] + 0.001); };
  });
  el.hidden = false;
}
function hideResults() {
  $('#results').hidden = true;
  $('#timeline').hidden = true;
  $('#stage').classList.remove('has-timeline');
}

// ---------------------------------------------------------------------------------------------
// Status, stats, panels

function updateStatus() {
  const el = $('#status');
  if (state.mode === 'test') {
    el.innerHTML = `Test loads: <b>${loadsSummary(state.loads)}</b>`;
    return;
  }
  if (!state.design.pieces.length) { el.innerHTML = 'Empty plot. Pick a tool and start building.'; return; }
  const c = state.check;
  if (!c) { el.innerHTML = 'Checking…'; return; }
  const S = { ...c.summary };
  // The solver counts parts; tell the player about whole pieces.
  S.unsupported = new Set(c.frames[0].fell.map((p) => state.model.parts[p]?.piece)).size;
  if (S.unsupported) {
    const byType = new Map();
    for (const pid of new Set(c.frames[0].fell.map((p) => state.model.parts[p]?.piece))) {
      const t = pieces.get(pid)?.type;
      if (t) byType.set(t, (byType.get(t) || 0) + 1);
    }
    const what = [...byType].map(([t, n]) => amountOf(t, n)).join(', ');
    el.innerHTML = `<b class="bad">⚠ Nothing is holding up ${what}</b> (glowing red). Everything needs a path down to the ground.`;
  }
  else if (S.failedCount) el.innerHTML = `<b class="bad">✗ Fails under its own weight.</b> ${describeElem(S.firstDamage)}.`;
  else if (S.worst) el.innerHTML = `<b class="good">✓ Stands under its own weight</b> · hardest-working: ${fmt(S.worst.util * 100)}% (${MATERIALS[S.worst.mat].name.toLowerCase()} ${S.worst.role})`;
  else el.innerHTML = '';
}

function updateStats() {
  updateChallengeBar();
  const t = state.model.totals;
  $('#stats').innerHTML = `
    <dt>Pieces</dt><dd>${fmt(state.design.pieces.length)}</dd>
    <dt>Weight</dt><dd>${fmt(t.mass / 1000, 1)} t</dd>
    <dt>Est. materials</dt><dd>R ${fmt(Math.round(t.cost / 100) * 100)}</dd>
    <dt>Frame</dt><dd>${fmt(state.model.nodes.length)} joints · ${fmt(state.model.elems.length)} members</dd>`;
}

// ---------------------------------------------------------------------------------------------
// Challenges

const CH_KEY = 'loadbearing.challenges';
function bestStars() { try { return JSON.parse(localStorage.getItem(CH_KEY) || '{}'); } catch { return {}; } }
function saveStars(id, n) {
  const b = bestStars();
  if ((b[id] || 0) >= n) return;
  b[id] = n;
  try { localStorage.setItem(CH_KEY, JSON.stringify(b)); } catch { /* ignore */ }
}
const starsHtml = (n) => `<span class="ch-stars" aria-label="${n} of 3 stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(3 - n)}</span></span>`;
function hazardText(ch) {
  const L = ch.loads, out = [];
  if (L.wind) out.push(`${fmt(L.wind)} m/s wind`);
  if (L.quake) out.push(`${fmt(L.quake, 2)} g quake`);
  if (L.snow) out.push(`${fmt(L.snow, 1)} kPa snow`);
  if (L.live >= 2) out.push(`${fmt(L.live, 1)} kPa crowd`);
  return out.join(' + ');
}
function renderChallenges() {
  const best = bestStars();
  const total = CHALLENGES.reduce((a, c) => a + (best[c.id] || 0), 0);
  $('#chProgress').textContent = `${total} / ${CHALLENGES.length * 3} ★`;
  $('#chList').innerHTML = CHALLENGES.map((c) => `
    <div class="ch-card${state.challenge === c.id ? ' on' : ''}" data-id="${c.id}">
      <div class="ch-head"><span class="ch-icon" aria-hidden="true">${c.icon}</span><b>${c.name}</b>${starsHtml(best[c.id] || 0)}</div>
      <p>${c.brief}</p>
      <div class="ch-meta">Budget R ${fmt(c.budget)} · ${hazardText(c)} · needs ${Object.entries(c.req).map(([k, v]) => REQ_TEXT[k](v)).join(', ')}</div>
      <button class="${state.challenge === c.id ? '' : 'primary'}">${state.challenge === c.id ? 'Back to building' : 'Take it on'}</button>
    </div>`).join('');
  $('#chList').querySelectorAll('.ch-card button').forEach((b) => {
    b.onclick = () => {
      state.challenge = b.closest('.ch-card').dataset.id;
      save();
      updateChallengeBar();
      setMode('build');
    };
  });
}
function updateChallengeBar() {
  const ch = CHALLENGES.find((c) => c.id === state.challenge);
  const bar = $('#challengeBar');
  $('#stage').classList.toggle('has-challenge', !!ch);
  if (!ch) { bar.hidden = true; return; }
  const got = measure(state.design), cost = state.model.totals.cost;
  const reqs = Object.entries(ch.req).map(([k, v]) => {
    const ok = got[k] >= v - 1e-9;
    return `<span class="req ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${REQ_TEXT[k](v)}${ok ? '' : ` (have ${fmt(got[k], k === 'storeys' ? 0 : 1)})`}</span>`;
  });
  const okCost = cost <= ch.budget;
  reqs.unshift(`<span class="req ${okCost ? 'ok' : 'no'}">${okCost ? '✓' : '✗'} R ${fmt(Math.round(cost / 100) * 100)} of R ${fmt(ch.budget)}</span>`);
  bar.innerHTML = `<span class="ch-title">${ch.icon} ${ch.name}</span><span class="req">${hazardText(ch)}</span>${reqs.join('')}
    <span class="ch-actions"><button class="primary" id="chTest">Test it</button><button id="chQuit" title="Leave this challenge" aria-label="Leave this challenge">✕</button></span>`;
  bar.hidden = false;
  $('#chTest').onclick = attemptChallenge;
  $('#chQuit').onclick = () => { state.challenge = null; save(); updateChallengeBar(); if (!$('#challengePanel').hidden) renderChallenges(); };
}
async function attemptChallenge() {
  const ch = CHALLENGES.find((c) => c.id === state.challenge);
  if (!ch || !state.design.pieces.length) return;
  $('#busy').hidden = false;
  $('#chTest').disabled = true;
  try {
    const runs = [];
    for (const L of loadCases(ch)) {
      const r = await analyse('test', { design: state.design, loads: L, push: false });
      if (!r) return;
      runs.push({ r, L });
    }
    const sc = score(ch, state.design, state.model.totals.cost, runs.map((x) => x.r.summary));
    // Show the direction that did the most damage.
    const bad = (x) => [x.r.summary.fallenFrac, x.r.summary.failedCount, x.r.summary.worst?.util || 0];
    runs.sort((a, b) => { const A = bad(a), B = bad(b); return B[0] - A[0] || B[1] - A[1] || B[2] - A[2]; });
    const shown = runs[0];
    if (sc.stars) saveStars(ch.id, sc.stars);
    Object.assign(state.loads, shown.L);
    state.scenario = 'custom';
    setMode('test');
    syncSliders();
    scene.setWeather(state.loads);
    startPlayback(shown.r, false, shown.L);
    const reasons = [];
    if (sc.missing.length) reasons.push(`The brief needs ${sc.missing.join(', ')}.`);
    if (sc.overBudget) reasons.push(`Over budget: R ${fmt(Math.round(state.model.totals.cost / 100) * 100)} of R ${fmt(ch.budget)}.`);
    if (sc.fell) reasons.push('Part of it came down.');
    let headline;
    if (!sc.stars) headline = `${ch.name}: not yet`;
    else if (sc.stars === 3) headline = `${ch.name}: perfect!`;
    else headline = `${ch.name}: passed`;
    const tips = [];
    if (sc.stars === 1) tips.push('Some members broke. Stop that for a second star.');
    if (sc.stars === 2) tips.push(`Undamaged! Get it under R ${fmt(0.75 * ch.budget)} (75% of the budget) for the third star.`);
    const dir = runs.length > 1 ? `<p class="lesson">Shown: the worse of the two directions (${shown.L.wind ? `wind from the ${compass(shown.L.windDir + 180)}` : `shaking ${shown.L.quakeDir ? 'N–S' : 'E–W'}`}).</p>` : '';
    const v = document.createElement('div');
    v.className = 'ch-verdict';
    v.innerHTML = `${starsHtml(sc.stars)}<b>${headline}</b>
      ${reasons.length || tips.length ? `<ul>${[...reasons, ...tips].map((t) => `<li>${t}</li>`).join('')}</ul>` : ''}
      <p class="lesson">💡 ${ch.lesson}</p>${dir}`;
    $('#results').prepend(v);
  } catch (err) {
    alert('Analysis failed: ' + err.message);
  } finally {
    $('#busy').hidden = true;
    const b = $('#chTest');
    if (b) b.disabled = false;
  }
}

function updateUndo() {
  $('#undoBtn').disabled = !state.undo.length;
  $('#redoBtn').disabled = !state.redo.length;
}

function setTool(id) {
  state.tool = id;
  document.querySelectorAll('#tools button').forEach((b) => { b.classList.toggle('on', b.dataset.tool === id); b.setAttribute('aria-pressed', String(b.dataset.tool === id)); });
  $('#roofOpts').hidden = id !== 'roof';
  scene.setLeftDrag(id === 'inspect');
  scene.setGhost(null);
  scene.setLevel(planeY(), state.mode === 'build');
  $('#stage').classList.toggle('placing', !['inspect', 'erase'].includes(id) && state.mode === 'build');
  $('#stage').classList.toggle('erasing', id === 'erase' && state.mode === 'build');
  updateHint();
  applyStyle();
}

function updateHint() {
  const nav = 'Right-drag orbits · middle-drag, Shift+right-drag or arrow keys pan · scroll zooms.';
  if (state.mode === 'test') {
    $('#hint').textContent = state.plTool ? `Click a red joint to add a point load. ${nav}` : `Set the loads, then run the test. Hover to inspect. Left-drag orbits.`;
  } else $('#hint').textContent = `${TOOLS.find((t) => t.id === state.tool).hint} ${nav}`;
}

function setStorey(s) {
  // One level above the top storey, so it can get a floor (a flat roof) too.
  state.storey = Math.max(0, Math.min(MAX_STOREYS, s));
  $('#storeyLabel').textContent = storeyName(state.storey).replace(/^./, (c) => c.toUpperCase());
  scene.setLevel(planeY(), state.mode === 'build');
  applyStyle();
}

function setMaterial(id) {
  state.mat = id;
  document.querySelectorAll('#mats button').forEach((b) => { b.classList.toggle('on', b.dataset.mat === id); b.setAttribute('aria-pressed', String(b.dataset.mat === id)); });
  const m = MATERIALS[id];
  $('#matInfo').innerHTML = `${m.blurb}<br>Stiffness ${fmt(m.E / 1e9)} GPa · strength ${fmt(m.fc / 1e6, m.fc < 1e7 ? 1 : 0)} MPa compression, ${fmt(m.ft / 1e6, m.ft < 1e6 ? 2 : 0)} MPa tension · ${fmt(m.rho)} kg/m³`;
  save();
}

function setMode(mode) {
  // The Challenges tab is a build-mode view with a different side panel.
  const panel = mode;
  state.panel = panel;
  if (mode === 'challenges') mode = 'build';
  state.mode = mode;
  $('#stage').dataset.mode = mode;
  $('.scene-heading h1').innerHTML = mode === 'build' ? 'A little ambition.<br>A lot of possibility.' : 'Put your ideas<br>under pressure.';
  $('.scene-heading p').textContent = mode === 'build' ? 'Build something. See what it can withstand.' : 'Choose a scenario. Find your structure’s limits.';
  document.querySelectorAll('#modeSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.mode === panel); b.setAttribute('aria-selected', String(b.dataset.mode === panel)); });
  $('#buildPanel').hidden = panel !== 'build';
  $('#testPanel').hidden = panel !== 'test';
  $('#challengePanel').hidden = panel !== 'challenges';
  if (panel === 'challenges') renderChallenges();
  scene.setGhost(null);
  hideTip();
  state.plTool = false;
  $('#plTool').classList.remove('on');
  if (mode === 'test') {
    scene.setLeftDrag(true);
    scene.setLevel(0, false);
    $('#stage').classList.remove('placing', 'erasing');
    scene.setWeather(state.loads);
  } else {
    resetTest();
    scene.setWeather({ wind: 0, snow: 0 });
    setTool(state.tool);
  }
  updateHint();
  updateStatus();
  applyStyle();
  showPointLoads();
}

// ---------------------------------------------------------------------------------------------
// Load sliders

const SLIDERS = [
  ['live', 'ldLive', (v) => `${fmt(v, 1)} kPa`],
  ['snow', 'ldSnow', (v) => `${fmt(v, 2)} kPa`],
  ['wind', 'ldWind', (v) => `${fmt(v)} m/s · ${fmt(v * 3.6)} km/h`],
  ['windDir', 'ldWindDir', (v) => `from ${compass(v + 180)}`],
  ['quake', 'ldQuake', (v) => `${fmt(v, 3)} g`],
  ['quakeDir', 'ldQuakeDir', (v) => `shaking ${['E–W', 'SE–NW', 'N–S', 'SW–NE'][Math.round(v / 45) % 4]}`],
];
function syncSliders() {
  for (const [k, id, f] of SLIDERS) {
    $('#' + id).value = state.loads[k];
    $('#' + id + 'Out').textContent = f(state.loads[k]);
  }
  $('#scenarioSel').value = state.scenario;
  $('#ldWind').closest('.slider').querySelector('.dir').style.opacity = state.loads.wind ? 1 : 0.4;
  $('#ldQuake').closest('.slider').querySelector('.dir').style.opacity = state.loads.quake ? 1 : 0.4;
}
function loadsChanged() {
  syncSliders();
  updateStatus();
  scene.setWeather(state.loads);
  if (state.test) resetTest();
  save();
}

// ---------------------------------------------------------------------------------------------
// Wire up the UI

function initUI() {
  const tools = $('#tools');
  TOOLS.forEach((t, k) => {
    const b = document.createElement('button');
    b.dataset.tool = t.id;
    b.title = `${t.label} (${k + 1})`;
    b.innerHTML = `${t.icon}<span>${t.label}</span><kbd>${(k + 1) % 10}</kbd>`;
    b.onclick = () => setTool(t.id);
    tools.appendChild(b);
  });
  const mats = $('#mats');
  if ($('#matCount')) $('#matCount').textContent = `${MATERIAL_IDS.length} MATERIALS`;
  for (const id of MATERIAL_IDS) {
    const m = MATERIALS[id];
    const b = document.createElement('button');
    b.dataset.mat = id;
    b.title = m.blurb;
    b.innerHTML = `<i style="background:#${m.color.toString(16).padStart(6, '0')}"></i>${m.name}`;
    b.onclick = () => { setMaterial(id); if (lastPointer) onHover(lastPointer.x, lastPointer.y); };
    mats.appendChild(b);
  }
  const ps = $('#presetSel');
  for (const p of PRESETS) ps.add(new Option(p.name, p.id));
  ps.onchange = () => { ps.title = PRESETS.find((p) => p.id === ps.value).blurb; };
  ps.onchange();
  $('#presetLoad').onclick = () => {
    const p = PRESETS.find((x) => x.id === ps.value);
    snapshot();
    state.design = p.design();
    rebuild();
    renderPointLoadList();
  };
  $('#clearBtn').onclick = () => {
    if (!state.design.pieces.length) return;
    snapshot();
    state.design = { grid: CELL, pieces: [], pointLoads: [] };
    rebuild();
    renderPointLoadList();
  };
  $('#undoBtn').onclick = undo;
  $('#redoBtn').onclick = redo;
  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'loadbearing', version: 1, ...state.design, loads: state.loads }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'house.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.pieces)) throw new Error('No pieces in that file.');
      // Files from before the 0.5 m grid get split onto it.
      const up = upgradeDesign({ ...d, pieces: d.pieces.filter((p) => TYPE_NAMES[p.type] && MATERIALS[p.mat] && Number.isFinite(p.id)) });
      snapshot();
      state.design = { grid: CELL, pieces: up.pieces, pointLoads: Array.isArray(d.pointLoads) ? d.pointLoads : [] };
      if (d.loads) Object.assign(state.loads, d.loads);
      rebuild();
      renderPointLoadList();
      syncSliders();
    } catch (err) {
      alert('Could not import that file: ' + err.message);
    }
    e.target.value = '';
  };

  document.querySelectorAll('#modeSeg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  $('#storeyUp').onclick = () => setStorey(state.storey + 1);
  $('#storeyDown').onclick = () => setStorey(state.storey - 1);
  $('#fadeAbove').onchange = (e) => { state.fadeAbove = e.target.checked; applyStyle(); };
  $('#showDeadStress').onchange = (e) => { state.deadStress = e.target.checked; applyStyle(); };
  $('#roofAxis').onchange = (e) => { state.roofAxis = e.target.value; };
  $('#roofStyle').onchange = (e) => { state.roofStyle = e.target.value; };
  $('#roofPitch').oninput = (e) => { state.roofPitch = +e.target.value; $('#roofPitchOut').textContent = e.target.value + '°'; };

  const sc = $('#scenarioSel');
  for (const s of SCENARIOS) sc.add(new Option(s.name, s.id));
  sc.onchange = () => {
    state.scenario = sc.value;
    const s = SCENARIOS.find((x) => x.id === sc.value);
    if (s.loads) Object.assign(state.loads, s.loads);
    loadsChanged();
  };
  for (const [k, id] of SLIDERS) {
    $('#' + id).oninput = (e) => {
      state.loads[k] = +e.target.value;
      if (!k.endsWith('Dir')) state.scenario = 'custom';
      loadsChanged();
    };
  }
  $('#plTool').onclick = () => {
    state.plTool = !state.plTool;
    $('#plTool').classList.toggle('on', state.plTool);
    scene.setLeftDrag(!state.plTool);
    updateHint();
    showPointLoads();
  };
  $('#runBtn').onclick = () => runTest(false);
  $('#pushBtn').onclick = () => runTest(true);
  $('#resetBtn').onclick = resetTest;
  $('#playBtn').onclick = () => {
    if (!state.test) return;
    if (!play.playing && play.t >= play.total - 0.01) seek(0);
    play.playing = !play.playing;
    updateTimeline();
  };
  $('#scrub').oninput = (e) => { play.playing = false; seek((+e.target.value / 1000) * play.total); };
  $('#exag').oninput = (e) => {
    state.exag = 10 ** +e.target.value;
    $('#exagOut').textContent = '×' + fmt(state.exag);
    if (state.test) renderFrame();
  };
  $('#exagOut').textContent = '×' + fmt(state.exag);
  $('#colorBy').onchange = (e) => {
    state.colorBy = e.target.value;
    $('#legendStress').hidden = state.colorBy !== 'stress';
    $('#legendForce').hidden = state.colorBy !== 'force';
    applyStyle();
  };
  $('#helpBtn').onclick = () => $('#help').showModal();
  $('#headerHelp').onclick = () => $('#help').showModal();
  let cameraView = 'perspective';
  const viewButtons = document.querySelectorAll('[data-view]');
  const updateViewButtons = () => viewButtons.forEach(b => {
    b.classList.toggle('on', b.dataset.view === cameraView);
    b.setAttribute('aria-pressed', String(b.dataset.view === cameraView));
  });
  viewButtons.forEach(b => { b.onclick = () => {
    cameraView = b.dataset.view; scene.setView(cameraView); updateViewButtons();
  }; });
  scene.controls.addEventListener('start', () => { cameraView = null; updateViewButtons(); });
  $('#fitView').onclick = () => { cameraView ||= 'perspective'; scene.setView(cameraView); updateViewButtons(); };
  updateViewButtons();

  window.addEventListener('keydown', (e) => {
    if ((e.target instanceof Element && e.target.matches('input[type=number], select')) || $('#help').open) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Arrow keys pan the view (in either mode).
    const panKeys = { ArrowLeft: [-0.06, 0], ArrowRight: [0.06, 0], ArrowUp: [0, 0.06], ArrowDown: [0, -0.06] };
    if (panKeys[e.key] && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      scene.pan(...panKeys[e.key]);
      return;
    }
    if (state.mode === 'build') {
      if (/^[0-9]$/.test(e.key)) {
        const n = e.key === '0' ? 10 : +e.key;
        if (n <= TOOLS.length) { setTool(TOOLS[n - 1].id); return; }
      }
      const k = e.key.toLowerCase();
      if (k === 'e' || e.key === 'PageUp') setStorey(state.storey + 1);
      if (k === 'q' || e.key === 'PageDown') setStorey(state.storey - 1);
      if (k === 'r') {
        const order = ['auto', 'x', 'z'];
        state.roofAxis = order[(order.indexOf(state.roofAxis) + 1) % 3];
        $('#roofAxis').value = state.roofAxis;
      }
      if (k === 'h') {
        state.roofStyle = state.roofStyle === 'hip' ? 'gable' : 'hip';
        $('#roofStyle').value = state.roofStyle;
      }
      if (e.key === 'Escape') { drag = null; scene.setGhost(null); }
      if (lastPointer) onHover(lastPointer.x, lastPointer.y);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (state.test) $('#playBtn').click(); else runTest(false);
    }
  });
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(JSON.stringify(state.design));
  state.design = JSON.parse(state.undo.pop());
  rebuild();
  renderPointLoadList();
  updateUndo();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(JSON.stringify(state.design));
  state.design = JSON.parse(state.redo.pop());
  rebuild();
  renderPointLoadList();
  updateUndo();
}

// ---------------------------------------------------------------------------------------------

loadSaved();
initUI();
setMaterial(state.mat);
syncSliders();
rebuild();
setTool(state.tool);
setStorey(0);
setMode('build');
renderPointLoadList();
updateUndo();
window.__app = { state, scene, play, runTest, setMode, setTool, place, seek };
