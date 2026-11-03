// Turns a design (a list of grid-snapped pieces) into a structural model:
//   nodes    – joints, fixed when they sit on the ground (y = 0, i.e. on a foundation)
//   elems    – 3D frame members (or axial-only struts) between two nodes
//   FD / FT  – nodal load vectors for the two load cases: D = dead (self-weight, always on)
//              and T = test loads (people, snow, wind, earthquake, point loads) that get ramped up
//   parts    – what the renderer draws; a part "falls" when its rules say so (see solver.js)
//
// How each piece is modelled:
//   column / beam  – one frame member.
//   wall panel     – four edge strips (frame members) plus two diagonal struts (axial only).
//                    The struts are the classic "equivalent diagonal strut" used for masonry
//                    infill: they give the panel its in-plane shear stiffness. Window / door
//                    panels get weaker struts because the opening interrupts the diagonal.
//   floor slab     – four edge strips carrying the floor load in bending, plus two diagonals
//                    so the floor acts as a stiff diaphragm that ties the walls together.
//   gable roof     – rafters, ridge beam, eave beams, ceiling ties and slope bracing.
//   cross bracing  – two pinned diagonals plus top and bottom chords.

import { MATERIALS, CELL, STOREY, G_ACC, PANEL, rect } from './materials.js';

export const QUAKE_R = 1;
export const MAXU = Math.max(1, Math.round(2 / CELL));   // structural panels are at most ~2 m
const EDGE_TYPES = new Set(['beam', 'wall', 'window', 'door', 'brace']);
const PANEL_TYPES = new Set(['wall', 'window', 'door']);
const stations = (a, b) => {
  const n = Math.max(1, Math.ceil((b - a) / MAXU));
  return Array.from({ length: n + 1 }, (_, k) => a + Math.round((k * (b - a)) / n));
};

// Designs saved before the fine grid used 2 m cells and have no `grid` field. Split each old
// piece into fine-grid pieces (a 2 m wall becomes four 0.5 m walls, a floor cell sixteen cells).
export function upgradeDesign(d) {
  if (!d || d.grid === CELL) return d;
  const f = Math.max(1, Math.round((d.grid ?? 2) / CELL));
  const pieces = [];
  let id = 1;
  const add = (p) => pieces.push({ ...p, id: id++ });
  for (const p of d.pieces || []) {
    if (p.type === 'column') add({ ...p, i: p.i * f, j: p.j * f });
    else if (p.type === 'slab') {
      for (let a = 0; a < f; a++) for (let b = 0; b < f; b++) add({ ...p, i: p.i * f + a, j: p.j * f + b });
    } else if (p.type === 'roof') add({ ...p, i0: p.i0 * f, j0: p.j0 * f, i1: p.i1 * f, j1: p.j1 * f });
    else if (EDGE_TYPES.has(p.type)) {
      const di = Math.sign(p.i2 - p.i1), dj = Math.sign(p.j2 - p.j1);
      const n = (Math.abs(p.i2 - p.i1) + Math.abs(p.j2 - p.j1)) * f;
      for (let k = 0; k < n; k++) {
        const i = p.i1 * f + di * k, j = p.j1 * f + dj * k;
        add({ ...p, i1: i, j1: j, i2: i + di, j2: j + dj });
      }
    }
  }
  return { ...d, grid: CELL, pieces };
}
const key = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => scale(a, 1 / len(a));

// A stable signature for "the same spot", used to replace a piece instead of stacking duplicates.
export function pieceSlot(p) {
  switch (p.type) {
    case 'column': return `c:${p.i},${p.j},${p.s}`;
    case 'beam': return `b:${edgeSig(p)},${p.s}`;
    case 'wall': case 'window': case 'door': case 'brace': return `w:${edgeSig(p)},${p.s}`;
    case 'slab': return `s:${p.i},${p.j},${p.s}`;
    case 'roof': return `r:${p.i0},${p.j0},${p.i1},${p.j1},${p.s}`;
  }
  return `?:${JSON.stringify(p)}`;
}
function edgeSig(p) {
  const a = [p.i1, p.j1], b = [p.i2, p.j2];
  const [m, n] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
  return `${m[0]},${m[1]},${n[0]},${n[1]}`;
}

export function roofCovers(r, i, j) {
  return i >= r.i0 && i < r.i1 && j >= r.j0 && j < r.j1;
}

export function buildModel(design, loads = {}) {
  const L = { live: 0, snow: 0, wind: 0, windDir: 0, quake: 0, quakeDir: 0, ...loads };
  const nodes = [];
  const nodeIndex = new Map();
  const elems = [];
  const parts = [];
  const panels = [];      // vertical wall panels, for wind exposure
  const columnsForWind = [];
  let cost = 0;

  const node = (x, y, z) => {
    const k = key(x, y, z);
    let id = nodeIndex.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodeIndex.set(k, id);
      nodes.push({ x, y, z, fixed: Math.abs(y) < 1e-6, fD: [0, 0, 0, 0, 0, 0], fT: [0, 0, 0, 0, 0, 0] });
    }
    return id;
  };
  const P = (id) => [nodes[id].x, nodes[id].y, nodes[id].z];

  const elem = (a, b, o) => {
    const id = elems.length;
    const m = MATERIALS[o.mat];
    const e = {
      id, n1: a, n2: b, mat: o.mat, E: m.E, fc: m.fc, ft: m.ft, fv: m.fv,
      sec: o.sec, truss: !!o.truss, pinned: !!o.pinned, release: o.release, anchor: o.anchor, role: o.role, vy: o.vy || [0, 1, 0],
      buckle: o.buckle !== false && !o.truss, piece: o.piece,
      wD: [0, 0, 0], wT: [0, 0, 0],
    };
    if (o.selfWeight) e.wD[1] -= m.rho * o.sec.A * G_ACC;
    elems.push(e);
    return id;
  };
  const addW = (eid, which, v) => {
    const w = elems[eid][which];
    w[0] += v[0]; w[1] += v[1]; w[2] += v[2];
  };
  const addF = (nid, which, v) => {
    const f = nodes[nid][which];
    f[0] += v[0]; f[1] += v[1]; f[2] += v[2];
  };
  const elemLen = (eid) => len(sub(P(elems[eid].n2), P(elems[eid].n1)));

  const slabs = design.pieces.filter((p) => p.type === 'slab');
  const roofs = design.pieces.filter((p) => p.type === 'roof');
  const exposed = (i, j, s) =>
    !slabs.some((q) => q.i === i && q.j === j && q.s > s) && !roofs.some((r) => r.s >= s && roofCovers(r, i, j));

  // ---- Fine-grid pieces → structural panels --------------------------------------------
  // You build on a fine grid (CELL). The structure is meshed coarser: runs of the same wall
  // merge into panels up to MAXU cells long, floors into rectangles up to MAXU × MAXU, and
  // roofs get rafters roughly every 2 m. That keeps the solver fast and keeps panels at the
  // proportions the equivalent-strut model was calibrated for. Each small piece still gets
  // its own render part (a slice of its panel) so you can hover, erase and watch it fall.
  const live = design.pieces.filter((p) => MATERIALS[p.mat]);
  const PT = (i, j, s) => `${i},${j},${s}`;
  const orient = (p) => (p.j1 === p.j2 ? 'x' : 'z');
  const edgeInfo = (p) => {
    const o = orient(p);
    return { p, o, line: o === 'x' ? p.j1 : p.i1, pos: o === 'x' ? Math.min(p.i1, p.i2) : Math.min(p.j1, p.j2) };
  };
  const isUnitEdge = (p) => Math.abs(p.i2 - p.i1) + Math.abs(p.j2 - p.j1) === 1;
  const at = (o, line, pos) => (o === 'x' ? [pos * CELL, line * CELL] : [line * CELL, pos * CELL]);

  const colPts = new Set(), ends = new Map();
  for (const p of live) {
    if (p.type === 'column') colPts.add(PT(p.i, p.j, p.s));
    else if (EDGE_TYPES.has(p.type) && isUnitEdge(p)) {
      for (const [i, j] of [[p.i1, p.j1], [p.i2, p.j2]]) {
        const k = PT(i, j, p.s);
        if (!ends.has(k)) ends.set(k, new Set());
        ends.get(k).add(orient(p));
      }
    }
  }

  function runsOf(list, keyFn) {
    const groups = new Map();
    for (const it of list) {
      const k = keyFn(it);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const out = [];
    for (const arr of groups.values()) {
      arr.sort((a, b) => a.pos - b.pos);
      let cur = [arr[0]];
      for (let k = 1; k < arr.length; k++) {
        const last = cur[cur.length - 1].pos;
        if (arr[k].pos === last) continue;
        if (arr[k].pos === last + 1) cur.push(arr[k]);
        else { out.push(cur); cur = [arr[k]]; }
      }
      out.push(cur);
    }
    return out;
  }
  // Split a run where something else meets it, then into near-equal chunks of ≤ MAXU cells.
  function chunks(run) {
    const { o, line } = run[0], s = run[0].p.s, other = o === 'x' ? 'z' : 'x';
    const brk = (q) => {
      const [i, j] = o === 'x' ? [q, line] : [line, q];
      return colPts.has(PT(i, j, s)) || !!ends.get(PT(i, j, s))?.has(other);
    };
    const segs = [];
    let cur = [run[0]];
    for (let k = 1; k < run.length; k++) {
      if (brk(run[k].pos)) { segs.push(cur); cur = []; }
      cur.push(run[k]);
    }
    segs.push(cur);
    const out = [];
    for (const sg of segs) {
      const n = sg.length, m = Math.ceil(n / MAXU);
      for (let k = 0; k < m; k++) out.push(sg.slice(Math.round((k * n) / m), Math.round(((k + 1) * n) / m)));
    }
    return out;
  }
  const clip = (rects, ua, ub) => rects.flatMap(([u0, u1, v0, v1, look, thick]) => {
    const a = Math.max(u0, ua), b = Math.min(u1, ub);
    return b - a > 1e-6 ? [[a, b, v0, v1, look, thick]] : [];
  });

  // Columns
  for (const p of live.filter((q) => q.type === 'column')) {
    const m = MATERIALS[p.mat];
    const x = p.i * CELL, z = p.j * CELL;
    const a = node(x, p.s * STOREY, z), b = node(x, (p.s + 1) * STOREY, z);
    const e = elem(a, b, { mat: p.mat, sec: m.column, role: 'column', selfWeight: true, vy: [1, 0, 0], piece: p.id });
    columnsForWind.push(e);
    cost += m.column.A * STOREY * m.cost;
    parts.push({ piece: p.id, mat: p.mat, nodes: [a, b], elems: [e], rules: [{ ids: [e], k: 1 }],
      prims: [{ t: 'bar', a, b, w: m.column.b, h: m.column.h, vy: [1, 0, 0], round: m.column.kind === 'tube' }] });
  }

  // Beams: a straight run of beam pieces is one continuous member.
  const beamEdges = live.filter((p) => p.type === 'beam' && isUnitEdge(p)).map(edgeInfo);
  for (const run of runsOf(beamEdges, (it) => `${it.p.s}|${it.o}|${it.line}|${it.p.mat}`)) {
    const { o, line } = run[0], p0 = run[0].p, m = MATERIALS[p0.mat];
    const A = run[0].pos, n = run.length, y = (p0.s + 1) * STOREY;
    const [x1, z1] = at(o, line, A), [x2, z2] = at(o, line, A + n);
    const a = node(x1, y, z1), b = node(x2, y, z2);
    const e = elem(a, b, { mat: p0.mat, sec: m.beam, role: 'beam', selfWeight: true, piece: p0.id });
    run.forEach((it, k) => {
      const ref = { seg: e, f0: k / n, f1: (k + 1) / n };
      cost += m.beam.A * CELL * m.cost;
      parts.push({ piece: it.p.id, mat: p0.mat, nodes: [a, b], elems: [ref], rules: [{ ids: [ref], k: 1 }],
        prims: [{ t: 'bar', a, b, f: [ref.f0, ref.f1], w: m.beam.b, h: m.beam.h, vy: [0, 1, 0], round: m.beam.kind === 'tube' }] });
    });
  }

  // Walls, window walls and door walls.
  const wallEdges = live.filter((p) => PANEL_TYPES.has(p.type) && isUnitEdge(p)).map(edgeInfo);
  for (const run of runsOf(wallEdges, (it) => `${it.p.s}|${it.o}|${it.line}|${it.p.type}|${it.p.mat}`)) {
    for (const g of chunks(run)) wallPanel(g);
  }
  function wallPanel(g) {
    const { o, line } = g[0], p0 = g[0].p, type = p0.type, m = MATERIALS[p0.mat];
    const n = g.length, w = n * CELL, A = g[0].pos;
    const y0 = p0.s * STOREY, y1 = y0 + STOREY;
    const [x1, z1] = at(o, line, A), [x2, z2] = at(o, line, A + n);
    const a0 = node(x1, y0, z1), b0 = node(x2, y0, z2), a1 = node(x1, y1, z1), b1 = node(x2, y1, z2);
    const dir = norm([x2 - x1, 0, z2 - z1]);
    const t = m.wallT;
    const hSec = rect(t, PANEL.edgeDepth);
    const vSec = rect(t, Math.min(PANEL.sideWidth, w / 5));
    const diag = Math.hypot(w, STOREY);
    const dSec = { A: PANEL.strutFactor * PANEL.strutScale[type] * diag * t };
    const o2 = { mat: p0.mat, piece: p0.id };
    const bottom = elem(a0, b0, { ...o2, sec: hSec, role: 'wall edge', vy: [0, 1, 0], buckle: false });
    const top = elem(a1, b1, { ...o2, sec: hSec, role: 'wall edge', vy: [0, 1, 0], buckle: false });
    const left = elem(a0, a1, { ...o2, sec: vSec, role: 'wall edge', vy: dir, buckle: false });
    const right = elem(b0, b1, { ...o2, sec: vSec, role: 'wall edge', vy: dir, buckle: false });
    const d1 = elem(a0, b1, { ...o2, sec: dSec, truss: true, role: 'wall shear strut' });
    const d2 = elem(b0, a1, { ...o2, sec: dSec, truss: true, role: 'wall shear strut' });
    const all = [bottom, top, left, right, d1, d2];

    const open = PANEL.opening[type];
    const area = w * STOREY;
    const W = area * (1 - open) * t * m.rho * G_ACC + area * open * PANEL.glazingKPa * 1000;
    for (const nd of [a0, b0, a1, b1]) addF(nd, 'fD', [0, -W / 4, 0]);
    cost += area * (1 - open) * t * m.cost + (type === 'window' ? area * open * PANEL.glazingCost : 0) +
      (type === 'door' ? PANEL.doorCost : 0);

    // The panel's look in (u along the wall, v up) coordinates, then sliced per piece.
    let rects;
    if (type === 'window') {
      rects = [[0, 1, 0, 0.33, 'mat', t], [0, 1, 0.8, 1, 'mat', t], [0, 0.25, 0.33, 0.8, 'mat', t], [0.75, 1, 0.33, 0.8, 'mat', t],
        [0.25, 0.75, 0.33, 0.8, 'glass', 0.02]];
    } else if (type === 'door') {
      const dw = Math.min(0.9, 0.8 * w) / w, du = (1 - dw) * 0.4;
      rects = [[0, 1, 0.72, 1, 'mat', t], [0, du, 0, 0.72, 'mat', t], [du + dw, 1, 0, 0.72, 'mat', t], [du, du + dw, 0, 0.72, 'door', 0.045]];
    } else rects = [[0, 1, 0, 1, 'mat', t]];
    const c = [a0, b0, b1, a1];
    g.forEach((it, k) => {
      const prims = clip(rects, k / n, (k + 1) / n).map(([u0, u1, v0, v1, look, thick]) => ({ t: 'quad', c, uv: [u0, u1, v0, v1], thick, look }));
      parts.push({ piece: it.p.id, mat: p0.mat, nodes: c, elems: all, share: 1 / n,
        rules: [{ ids: [left, right], k: 2 }], prims, extraMass: W / G_ACC / n });
    });
    panels.push({ nodes: { a0, b0, a1, b1 }, p0: [x1, y0, z1], dir, n: [-dir[2], 0, dir[0]], w, h: STOREY });
  }

  // Cross bracing: two pinned diagonals plus top and bottom chords in an open bay.
  const braceEdges = live.filter((p) => p.type === 'brace' && isUnitEdge(p)).map(edgeInfo);
  for (const run of runsOf(braceEdges, (it) => `${it.p.s}|${it.o}|${it.line}|${it.p.mat}`)) {
    for (const g of chunks(run)) {
      const { o, line } = g[0], p0 = g[0].p, m = MATERIALS[p0.mat];
      const n = g.length, A = g[0].pos, w = n * CELL;
      const y0 = p0.s * STOREY, y1 = y0 + STOREY;
      const [x1, z1] = at(o, line, A), [x2, z2] = at(o, line, A + n);
      const a0 = node(x1, y0, z1), b0 = node(x2, y0, z2), a1 = node(x1, y1, z1), b1 = node(x2, y1, z2);
      const sec = m.brace || m.beam;
      const o2 = { mat: p0.mat, piece: p0.id, sec, selfWeight: true };
      const d1 = elem(a0, b1, { ...o2, role: 'brace', pinned: true });
      const d2 = elem(b0, a1, { ...o2, role: 'brace', pinned: true });
      const ct = elem(a1, b1, { ...o2, role: 'brace chord', buckle: false });
      const cb = elem(a0, b0, { ...o2, role: 'brace chord', buckle: false });
      cost += sec.A * (2 * Math.hypot(w, STOREY) + 2 * w) * m.cost;
      const bar = (a, b, f) => ({ t: 'bar', a, b, f, w: sec.b, h: sec.h, vy: [0, 1, 0], round: sec.kind === 'tube' });
      g.forEach((it, k) => {
        const f = [k / n, (k + 1) / n];
        parts.push({ piece: it.p.id, mat: p0.mat, nodes: [a0, b0, a1, b1], share: 1 / n,
          elems: [d1, d2, { seg: ct, f0: f[0], f1: f[1] }, { seg: cb, f0: f[0], f1: f[1] }],
          rules: [{ ids: [d1, d2], k: 2 }],
          prims: [bar(a0, b1, f), bar(b0, a1, f), bar(a1, b1, f), bar(a0, b0, f)] });
      });
    }
  }

  // Floors: merge cells into rectangles up to MAXU × MAXU. A rectangle never spans across a
  // wall or beam line (or over a column), so whatever is underneath really holds it up.
  const slabCells = new Map(), supportEdge = new Set();
  for (const p of live) {
    if (p.type === 'slab') slabCells.set(PT(p.i, p.j, p.s), p);
    else if ((p.type === 'beam' || PANEL_TYPES.has(p.type) || p.type === 'brace') && isUnitEdge(p)) {
      const { o, line, pos } = edgeInfo(p);
      supportEdge.add(`${p.s}|${o}|${line}|${pos}`);                         // top of its storey
      if (p.type !== 'beam') supportEdge.add(`${p.s - 1}|${o}|${line}|${pos}`); // standing on the floor below
    }
  }
  const colAtLevel = (i, j, s) => colPts.has(PT(i, j, s)) || colPts.has(PT(i, j, s + 1));
  const done = new Set();
  const slabList = [...slabCells.values()].sort((a, b) => a.s - b.s || a.j - b.j || a.i - b.i);
  for (const p0 of slabList) {
    if (done.has(p0.id)) continue;
    const s = p0.s, I = p0.i, J = p0.j;
    const cell = (i, j) => { const q = slabCells.get(PT(i, j, s)); return q && q.mat === p0.mat && !done.has(q.id) ? q : null; };
    const sup = (o, line, pos) => supportEdge.has(`${s}|${o}|${line}|${pos}`);
    let w = 1, h = 1;
    const canCol = (x) => {
      for (let y = 0; y < h; y++) {
        if (!cell(I + x, J + y) || sup('z', I + x, J + y)) return false;
        if (y > 0 && (sup('x', J + y, I + x) || colAtLevel(I + x, J + y, s))) return false;
      }
      return true;
    };
    while (w < MAXU && canCol(w)) w++;
    const canRow = (y) => {
      for (let x = 0; x < w; x++) {
        if (!cell(I + x, J + y) || sup('x', J + y, I + x)) return false;
        if (x > 0 && (sup('z', I + x, J + y) || colAtLevel(I + x, J + y, s))) return false;
      }
      return true;
    };
    while (h < MAXU && canRow(h)) h++;

    const m = MATERIALS[p0.mat];
    const y = (s + 1) * STOREY, X = I * CELL, Z = J * CELL, WX = w * CELL, WZ = h * CELL;
    const c00 = node(X, y, Z), c10 = node(X + WX, y, Z), c11 = node(X + WX, y, Z + WZ), c01 = node(X, y, Z + WZ);
    const t = m.slabT;
    const eSec = rect(PANEL.slabStrip, t);
    const dSec = { A: PANEL.strutFactor * Math.hypot(WX, WZ) * t };
    const o = { mat: p0.mat, piece: p0.id, role: 'floor edge', sec: eSec, buckle: false };
    const edges = [elem(c00, c10, o), elem(c10, c11, o), elem(c11, c01, o), elem(c01, c00, o)];
    const diags = [
      elem(c00, c11, { mat: p0.mat, piece: p0.id, sec: dSec, truss: true, role: 'floor diaphragm' }),
      elem(c10, c01, { mat: p0.mat, piece: p0.id, sec: dSec, truss: true, role: 'floor diaphragm' }),
    ];
    const cells = [];
    for (let x = 0; x < w; x++) for (let z = 0; z < h; z++) cells.push([x, z, cell(I + x, J + z)]);
    // Area loads go round the four edges as an even line load (N per metre).
    const perM = (WX * WZ) / (2 * (WX + WZ));
    const expFrac = cells.filter(([x, z]) => exposed(I + x, J + z, s)).length / cells.length;
    const dead = (m.rho * t * G_ACC + PANEL.finishesKPa * 1000) * perM;
    const test = (L.live + L.snow * expFrac) * 1000 * perM;
    for (const e of edges) { addW(e, 'wD', [0, -dead, 0]); addW(e, 'wT', [0, -test, 0]); }
    const quad = [c00, c10, c11, c01];
    for (const [x, z, q] of cells) {
      done.add(q.id);
      cost += CELL * CELL * t * m.cost;
      parts.push({ piece: q.id, mat: p0.mat, nodes: quad, elems: [...edges, ...diags], share: 1 / cells.length,
        rules: [{ ids: edges, k: 2 }],
        prims: [{ t: 'quad', c: quad, uv: [x / w, (x + 1) / w, z / h, (z + 1) / h], thick: t, offset: -t / 2, look: 'mat', horizontal: true }] });
    }
  }

  for (const p of live) if (p.type === 'roof') buildRoof(p, MATERIALS[p.mat]);

  function buildRoof(p, m) {
    const pid = p.id;
    const fmId = m.roofFrame || p.mat;     // material of rafters, ties and beams
    const fm = MATERIALS[fmId];
    const top = (p.s + 1) * STOREY;
    const alongX = p.axis !== 'z';
    // u runs along the ridge, v across it (both in grid cells).
    const [u0, u1, v0, v1] = alongX ? [p.i0, p.i1, p.j0, p.j1] : [p.j0, p.j1, p.i0, p.i1];
    const XZ = (u, v) => (alongX ? [u * CELL, v * CELL] : [v * CELL, u * CELL]);
    const nAt = (u, v, y = top) => { const [x, z] = XZ(u, v); return node(x, y, z); };
    const half = ((v1 - v0) * CELL) / 2;
    const pitch = ((p.pitch ?? 30) * Math.PI) / 180;
    const rise = half * Math.tan(pitch);
    const vm = (v0 + v1) / 2;
    const raftLen = Math.hypot(half, rise);
    const sec = fm.beam;
    const tieSec = fm.beam;
    const braceSec = { A: sec.A * 0.25 };
    const o = { mat: fmId, piece: pid };
    const round = sec.kind === 'tube';
    // Trusses roughly every 2 m along the ridge; ceiling bracing in strips about 2 m wide.
    const us = stations(u0, u1), vs = stations(v0, v1);
    const bay = (k) => (us[k + 1] - us[k]) * CELL;
    const eA = [], eB = [], rg = [], rA = [], rB = [];

    us.forEach((u, k) => {
      eA.push(nAt(u, v0));
      eB.push(nAt(u, v1));
      rg.push(nAt(u, vm, top + rise));
      const trib = ((k > 0 ? bay(k - 1) : 0) + (k < us.length - 1 ? bay(k) : 0)) / 2;
      // Rafters are pinned at both ends; the foot is held down by a strap with limited uplift
      // capacity (fm.anchor is for a rafter every 2 m).
      const anchor = (fm.anchor * trib) / 2;
      rA.push(elem(eA[k], rg[k], { ...o, sec, role: 'rafter', selfWeight: true, pinned: true, anchor }));
      rB.push(elem(eB[k], rg[k], { ...o, sec, role: 'rafter', selfWeight: true, pinned: true, anchor }));
      // Ceiling tie across the span: continuous over interior walls (it gets joined to anything
      // it crosses), but nailed (pinned) where it meets the eaves.
      const te = elem(eA[k], eB[k], { ...o, sec: tieSec, role: 'ceiling tie', selfWeight: true, release: [true, true] });
      addW(te, 'wD', [0, -0.25e3 * trib, 0]);
      cost += tieSec.A * (v1 - v0) * CELL * fm.cost;
      for (let b = 0; b < vs.length - 1; b++) {
        const ref = { seg: te, f0: (vs[b] - v0) / (v1 - v0), f1: (vs[b + 1] - v0) / (v1 - v0) };
        parts.push({ piece: pid, mat: fmId, nodes: [nAt(u, vs[b]), nAt(u, vs[b + 1])], elems: [ref], rules: [{ ids: [ref], k: 1 }],
          prims: [{ t: 'bar', a: eA[k], b: eB[k], f: [ref.f0, ref.f1], w: tieSec.b * 0.6, h: tieSec.h * 0.6, vy: [0, 1, 0], round }] });
      }
      for (const [eav, r] of [[eA[k], rA[k]], [eB[k], rB[k]]]) {
        cost += sec.A * raftLen * fm.cost;
        parts.push({ piece: pid, mat: fmId, nodes: [eav, rg[k]], elems: [r], rules: [{ ids: [r], k: 1 }],
          prims: [{ t: 'bar', a: eav, b: rg[k], w: sec.b, h: sec.h, vy: [0, 1, 0], round }] });
      }
    });

    // Ceiling diaphragm: brandering + boards act as horizontal bracing at eave level, so wind or
    // quake load at the top of a wall can travel sideways into the walls parallel to it.
    const oo = { ...o, sec: { A: 0.003 }, truss: true, role: 'ceiling bracing' };
    for (let a = 0; a < us.length - 1; a++) for (let b = 0; b < vs.length - 1; b++) {
      const [ua, ub, va, vb] = [us[a], us[a + 1], vs[b], vs[b + 1]];
      if (b > 0) elem(nAt(ua, va), nAt(ub, va), oo);
      elem(nAt(ua, va), nAt(ub, vb), oo);
      elem(nAt(ub, va), nAt(ua, vb), oo);
    }

    const slopeN = (eav, rid) => {
      // Outward normal of a slope (pointing up and away from the ridge).
      const s = sub(P(rid), P(eav));
      const along = alongX ? [1, 0, 0] : [0, 0, 1];
      const n = norm([along[1] * s[2] - along[2] * s[1], along[2] * s[0] - along[0] * s[2], along[0] * s[1] - along[1] * s[0]]);
      return n[1] < 0 ? scale(n, -1) : n;
    };

    for (let k = 0; k < us.length - 1; k++) {
      const bl = bay(k);
      for (const [eaves, rafters] of [[eA, rA], [eB, rB]]) {
        const eb = elem(eaves[k], eaves[k + 1], { ...o, sec, role: 'eave beam', selfWeight: true });
        const b1 = elem(eaves[k], rg[k + 1], { ...o, sec: braceSec, truss: true, role: 'roof bracing' });
        const b2 = elem(eaves[k + 1], rg[k], { ...o, sec: braceSec, truss: true, role: 'roof bracing' });
        cost += sec.A * bl * fm.cost + bl * raftLen * m.claddingCost;
        parts.push({ piece: pid, mat: fmId, nodes: [eaves[k], eaves[k + 1]], elems: [eb], rules: [{ ids: [eb], k: 1 }],
          prims: [{ t: 'bar', a: eaves[k], b: eaves[k + 1], w: sec.b, h: sec.h, vy: [0, 1, 0], round }] });
        // Roof covering on this bay, carried by the two rafters either side.
        const n = slopeN(eaves[k], rg[k]);
        const trib = bl / 2;
        for (const r of [rafters[k], rafters[k + 1]]) {
          addW(r, 'wD', [0, -m.cladding * 1e3 * trib, 0]);
          addW(r, 'wT', [0, -L.snow * 1e3 * Math.cos(pitch) * trib, 0]);
          // Wind suction lifts roofs off: external Cp ≈ −0.6 on both slopes plus +0.2 internal
          // pressure pushing up from inside.
          const qw = 0.8 * 0.5 * 1.2 * L.wind ** 2 * trib;
          addW(r, 'wT', scale(n, qw));
        }
        const c = [eaves[k], eaves[k + 1], rg[k + 1], rg[k]];
        parts.push({ piece: pid, mat: p.mat, nodes: c, elems: [b1, b2], rules: [{ ids: [rafters[k], rafters[k + 1]], k: 1 }],
          prims: [{ t: 'quad', c, uv: [0, 1, 0, 1], thick: 0.06, offset: sec.h / 2 + 0.03, look: 'roof', normalHint: n }] });
      }
      const re = elem(rg[k], rg[k + 1], { ...o, sec, role: 'ridge beam', selfWeight: true });
      cost += sec.A * bl * fm.cost;
      parts.push({ piece: pid, mat: fmId, nodes: [rg[k], rg[k + 1]], elems: [re], rules: [{ ids: [re], k: 1 }],
        prims: [{ t: 'bar', a: rg[k], b: rg[k + 1], w: sec.b, h: sec.h, vy: [0, 1, 0], round }] });
    }

    // Gable-end infill triangles (visual + weight, carried by the end rafters).
    for (const k of [0, us.length - 1]) {
      const area = half * rise;
      const W = area * 0.05 * m.rho * G_ACC;
      for (const r of [rA[k], rB[k]]) addW(r, 'wD', [0, -W / 2 / raftLen, 0]);
      cost += area * 0.05 * m.cost;
      parts.push({ piece: pid, mat: p.mat, nodes: [eA[k], eB[k], rg[k]], elems: [], rules: [{ ids: [rA[k], rB[k]], k: 1 }],
        prims: [{ t: 'tri', c: [eA[k], eB[k], rg[k]], thick: 0.05, look: 'mat' }] });
    }
  }

  // ---- Join members that meet ------------------------------------------------------------
  // Pieces on the fine grid don't all share corners, so horizontal members at the same level
  // are joined wherever one crosses another or a joint sits on it (a floor edge resting on a
  // wall, a ceiling tie over an interior wall...). Then part references are re-pointed.
  const segs = splitAtJunctions();
  const resolve = (x) => (typeof x === 'number' ? segs[x].map((sg) => sg.id)
    : segs[x.seg].filter((sg) => sg.t0 < x.f1 - 1e-6 && sg.t1 > x.f0 + 1e-6).map((sg) => sg.id));
  for (const part of parts) {
    part.elems = [...new Set(part.elems.flatMap(resolve))];
    part.rules = part.rules.map((r) => ({ k: r.k, ids: r.ids.map((x) => { const l = resolve(x); return l.length === 1 ? l[0] : l; }) }));
  }
  for (let k = 0; k < columnsForWind.length; k++) columnsForWind[k] = segs[columnsForWind[k]][0].id;

  function splitAtJunctions() {
    const EPS = 1e-6, yk = (y) => Math.round(y * 1000);
    const horiz = new Set(elems.filter((e) => !e.truss && Math.abs(nodes[e.n1].y - nodes[e.n2].y) < EPS));
    const byLevel = new Map();
    for (const e of horiz) {
      const k = yk(nodes[e.n1].y);
      if (!byLevel.has(k)) byLevel.set(k, []);
      byLevel.get(k).push(e);
    }
    for (const list of byLevel.values()) {
      for (let a = 0; a < list.length; a++) {
        const A = nodes[list[a].n1], B = nodes[list[a].n2];
        const rx = B.x - A.x, rz = B.z - A.z;
        for (let b = a + 1; b < list.length; b++) {
          const C = nodes[list[b].n1], D = nodes[list[b].n2];
          const sx = D.x - C.x, sz = D.z - C.z;
          const den = rx * sz - rz * sx;
          if (Math.abs(den) < EPS) continue;
          const qx = C.x - A.x, qz = C.z - A.z;
          const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
          if (t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS) node(A.x + t * rx, A.y, A.z + t * rz);
        }
      }
    }
    const nodesAt = new Map();
    nodes.forEach((n, id) => {
      const k = yk(n.y);
      if (!nodesAt.has(k)) nodesAt.set(k, []);
      nodesAt.get(k).push(id);
    });
    const out = [], map = [];
    for (const e of elems) {
      const cuts = [];
      if (horiz.has(e)) {
        const A = nodes[e.n1], B = nodes[e.n2];
        const dx = B.x - A.x, dz = B.z - A.z, L2 = dx * dx + dz * dz;
        for (const id of nodesAt.get(yk(A.y))) {
          if (id === e.n1 || id === e.n2) continue;
          const n = nodes[id];
          const t = ((n.x - A.x) * dx + (n.z - A.z) * dz) / L2;
          if (t <= EPS || t >= 1 - EPS) continue;
          const ex = A.x + t * dx - n.x, ez = A.z + t * dz - n.z;
          if (ex * ex + ez * ez < 1e-8) cuts.push([t, id]);
        }
        cuts.sort((a, b) => a[0] - b[0]);
      }
      const old = e.id;
      map[old] = [];
      if (!cuts.length) {
        e.id = out.length;
        out.push(e);
        map[old].push({ id: e.id, t0: 0, t1: 1 });
        continue;
      }
      const chain = [[0, e.n1], ...cuts, [1, e.n2]];
      const rel = e.release || (e.pinned ? [true, true] : [false, false]);
      for (let k = 0; k < chain.length - 1; k++) {
        const c = { ...e, id: out.length, n1: chain[k][1], n2: chain[k + 1][1], pinned: false,
          release: [k === 0 && rel[0], k === chain.length - 2 && rel[1]], wD: [...e.wD], wT: [...e.wT] };
        out.push(c);
        map[old].push({ id: c.id, t0: chain[k][0], t1: chain[k + 1][0] });
      }
    }
    elems.length = 0;
    elems.push(...out);
    return map;
  }

  // ---- Wind on walls -------------------------------------------------------------------
  // Dynamic pressure q = ½ρv². A wall is windward if nothing upstream shields it (Cp +0.8)
  // and leeward if nothing downstream does (Cp −0.5 suction). Both push the same way.
  if (L.wind > 0) {
    const th = (L.windDir * Math.PI) / 180;
    const d = [Math.cos(th), 0, Math.sin(th)];
    const qw = 0.5 * 1.2 * L.wind ** 2;
    const hits = (o, r, self) => panels.some((pn) => pn !== self && rayHitsPanel(o, r, pn));
    for (const pn of panels) {
      const c = pn.n[0] * d[0] + pn.n[2] * d[2];
      if (Math.abs(c) < 0.05) continue;
      const centre = [pn.p0[0] + pn.dir[0] * pn.w / 2, pn.p0[1] + pn.h / 2, pn.p0[2] + pn.dir[2] * pn.w / 2];
      const up = scale(d, -1);
      const windward = !hits(centre, up, pn);
      const leeward = !hits(centre, d, pn);
      const cp = (windward ? 0.8 : 0) + (leeward ? 0.5 : 0);
      if (!cp) continue;
      const F = qw * cp * Math.abs(c) * pn.w * pn.h;
      const dirF = scale(pn.n, Math.sign(c) * F / 4);
      for (const nid of Object.values(pn.nodes)) addF(nid, 'fT', dirF);
    }
    // Drag on bare columns (Cd ≈ 1.2).
    for (const e of columnsForWind) {
      const s = elems[e].sec;
      addW(e, 'wT', scale(d, qw * 1.2 * Math.max(s.b, s.h)));
    }
  }

  // ---- Masses (for earthquake) ----------------------------------------------------------
  const mass = new Float64Array(nodes.length);
  for (const e of elems) {
    const half = (-e.wD[1] * elemLen(e.id)) / 2 / G_ACC;
    mass[e.n1] += half;
    mass[e.n2] += half;
  }
  nodes.forEach((n, i) => { mass[i] += -n.fD[1] / G_ACC; });
  const totalMass = mass.reduce((a, b) => a + b, 0);

  // ---- Earthquake: equivalent static lateral force ---------------------------------------
  // Base shear V = Cs·W with Cs = 2.5 × peak ground acceleration (the plateau of a typical
  // design spectrum), treating the house as elastic (behaviour factor R = 1), shared out up
  // the height in proportion to mass × height (first mode shape).
  if (L.quake > 0) {
    const th = (L.quakeDir * Math.PI) / 180;
    const d = [Math.cos(th), 0, Math.sin(th)];
    let sumM = 0, sumMY = 0;
    nodes.forEach((n, i) => { if (!n.fixed) { sumM += mass[i]; sumMY += mass[i] * n.y; } });
    const V = (2.5 / QUAKE_R) * L.quake * sumM * G_ACC;
    if (sumMY > 0) nodes.forEach((n, i) => {
      if (!n.fixed) addF(i, 'fT', scale(d, (V * mass[i] * n.y) / sumMY));
    });
  }

  // ---- Point loads ----------------------------------------------------------------------
  for (const pl of design.pointLoads || []) {
    const id = nodeIndex.get(key(pl.x, pl.y, pl.z));
    if (id !== undefined) addF(id, 'fT', [pl.fx * 1e3, pl.fy * 1e3, pl.fz * 1e3]);
  }

  const n = nodes.length;
  const FD = new Float64Array(6 * n), FT = new Float64Array(6 * n);
  nodes.forEach((nd, i) => { for (let k = 0; k < 6; k++) { FD[6 * i + k] = nd.fD[k]; FT[6 * i + k] = nd.fT[k]; } });

  return {
    nodes: nodes.map(({ x, y, z, fixed }) => ({ x, y, z, fixed })),
    nodeKey: key, nodeIndex, elems, parts, FD, FT, mass,
    totals: { mass: totalMass, cost, pieces: design.pieces.length },
  };
}

function rayHitsPanel(o, r, pn) {
  const denom = r[0] * pn.n[0] + r[2] * pn.n[2];
  if (Math.abs(denom) < 1e-9) return false;
  const t = ((pn.p0[0] - o[0]) * pn.n[0] + (pn.p0[2] - o[2]) * pn.n[2]) / denom;
  if (t < 1e-3) return false;
  const q = [o[0] + r[0] * t, o[1], o[2] + r[2] * t];
  const s = (q[0] - pn.p0[0]) * pn.dir[0] + (q[2] - pn.p0[2]) * pn.dir[2];
  const yy = q[1] - pn.p0[1];
  return s > -1e-6 && s < pn.w + 1e-6 && yy >= 0 && yy <= pn.h;
}
