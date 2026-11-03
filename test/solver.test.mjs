// Checks the frame solver against textbook results, then sanity-checks whole houses.
// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Structure } from '../public/engine/solver.js';
import { buildModel, upgradeDesign } from '../public/engine/model.js';
import { rect } from '../public/engine/materials.js';
import { PRESETS } from '../public/engine/presets.js';

const E = 200e9;
const sec = rect(0.1, 0.2);
const mkElem = (n1, n2, extra = {}) => ({
  n1, n2, mat: 'steel', E, fc: 1e12, ft: 1e12, fv: 1e12, sec, truss: false, role: 'test', vy: [0, 1, 0],
  buckle: false, wD: [0, 0, 0], wT: [0, 0, 0], ...extra,
});
function model(nodes, elems, loadsT = [], loadsD = []) {
  const FD = new Float64Array(nodes.length * 6), FT = new Float64Array(nodes.length * 6);
  for (const [n, d, v] of loadsT) FT[n * 6 + d] += v;
  for (const [n, d, v] of loadsD) FD[n * 6 + d] += v;
  return { nodes, elems: elems.map((e, id) => ({ id, ...e })), parts: [], FD, FT };
}
const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} ≠ ${b}`);

test('cantilever tip load: δ = PL³/3EI, both bending planes', () => {
  const L = 4, P = 10e3;
  for (const [dof, I] of [[1, sec.Iz], [2, sec.Iy]]) {
    const m = model([{ x: 0, y: 0, z: 0, fixed: true }, { x: L, y: 0.0001, z: 0, fixed: false }],
      [mkElem(0, 1)], [[1, dof, -P]]);
    const s = new Structure(m);
    const active = new Uint8Array(1).fill(1);
    const sol = s.solve(active, s.reach(active));
    close(sol.uT[6 + dof], -(P * L ** 3) / (3 * E * I));
    // root moment = P·L
    const d = s.describe(0, sol, 1);
    close(d.M, P * L);
  }
});

test('fixed-fixed beam with UDL: midspan δ = wL⁴/384EI, end moment wL²/12', () => {
  const L = 6, w = 5e3;
  // three nodes so we can read the midspan deflection
  const m = model(
    [{ x: 0, y: 3, z: 0, fixed: false }, { x: L / 2, y: 3, z: 0, fixed: false }, { x: L, y: 3, z: 0, fixed: false },
     { x: 0, y: 0, z: 0, fixed: true }, { x: L, y: 0, z: 0, fixed: true }],
    [mkElem(0, 1, { wT: [0, -w, 0] }), mkElem(1, 2, { wT: [0, -w, 0] }),
     mkElem(3, 0, { sec: rect(5, 5) }), mkElem(4, 2, { sec: rect(5, 5) })]); // near-rigid supports
  const s = new Structure(m);
  const active = new Uint8Array(4).fill(1);
  const sol = s.solve(active, s.reach(active));
  close(sol.uT[6 + 1], -(w * L ** 4) / (384 * E * sec.Iz), 0.02);
  close(s.describe(0, sol, 1).M, (w * L * L) / 12, 0.02);
});

test('axial bar and Euler buckling utilisation', () => {
  const L = 3, P = 50e3;
  const col = { ...mkElem(0, 1, { vy: [1, 0, 0], buckle: true, fc: 355e6, ft: 355e6 }) };
  const m = model([{ x: 0, y: 0, z: 0, fixed: true }, { x: 0, y: L, z: 0, fixed: false }], [col], [[1, 1, -P]]);
  const s = new Structure(m);
  const active = new Uint8Array(1).fill(1);
  const sol = s.solve(active, s.reach(active));
  close(sol.uT[6 + 1], -(P * L) / (E * sec.A));
  const Pcr = (Math.PI ** 2 * E * Math.min(sec.Iy, sec.Iz)) / L ** 2;
  close(s.check(0, sol, 1).util, P / Pcr + P / (355e6 * sec.A));
});

test('portal frame sways, and a symmetric load does not', () => {
  const nodes = [{ x: 0, y: 0, z: 0, fixed: true }, { x: 0, y: 3, z: 0 }, { x: 4, y: 3, z: 0 }, { x: 4, y: 0, z: 0, fixed: true }];
  const elems = [mkElem(0, 1, { vy: [1, 0, 0] }), mkElem(1, 2), mkElem(2, 3, { vy: [1, 0, 0] })];
  const s = new Structure(model(nodes, elems, [[1, 0, 10e3]], [[1, 1, -10e3], [2, 1, -10e3]]));
  const a = new Uint8Array(3).fill(1);
  const sol = s.solve(a, s.reach(a));
  assert.ok(sol.uT[6] > 0 && Math.abs(sol.uT[6] - sol.uT[12]) < 1e-2 * sol.uT[6], 'beam keeps length');
  assert.ok(Math.abs(sol.uD[6]) < 1e-9, 'symmetric gravity, no sway');
});

test('every preset stands up under its own weight', () => {
  for (const p of PRESETS) {
    const s = new Structure(buildModel(p.design()));
    const r = s.run({ deadOnly: true });
    assert.equal(r.summary.failedCount, 0, `${p.name}: ${JSON.stringify(r.summary.firstDamage)}`);
    assert.equal(r.summary.unsupported, 0, p.name);
    console.log(`${p.name.padEnd(28)} nodes ${String(s.nn).padStart(4)} members ${String(s.ne).padStart(4)}  max util ${r.summary.worst ? (r.summary.worst.util * 100).toFixed(0) + "% (" + r.summary.worst.mat + " " + r.summary.worst.role + ")" : "-"}`);
  }
});

test('floating piece is reported as unsupported', () => {
  const d = { pieces: [{ id: 1, type: 'column', mat: 'timber', i: 0, j: 0, s: 1 }], pointLoads: [] };
  const r = new Structure(buildModel(upgradeDesign(d))).run({ deadOnly: true });
  assert.equal(r.summary.unsupported, 1);
});

test('pinned member with UDL: simple-span moment wL²/8, no end moments', () => {
  const L = 4, w = 3e3;
  const nodes = [{ x: 0, y: 3, z: 0 }, { x: L, y: 3, z: 0 }, { x: 0, y: 0, z: 0, fixed: true }, { x: L, y: 0, z: 0, fixed: true }];
  const elems = [mkElem(0, 1, { pinned: true, wT: [0, -w, 0] }), mkElem(2, 0, { vy: [1, 0, 0] }), mkElem(3, 1, { vy: [1, 0, 0] })];
  const s = new Structure(model(nodes, elems));
  const a = new Uint8Array(3).fill(1);
  const sol = s.solve(a, s.reach(a));
  close(s.describe(0, sol, 1).M, (w * L * L) / 8, 1e-6);
  assert.ok(s.describe(1, sol, 1).M < 1, 'no moment transferred');
});

test('wind loads the exposed walls only, not a wall sheltered inside', () => {
  const walls = [];
  let id = 1;
  for (const i of [0, 2]) walls.push({ id: id++, type: 'wall', mat: 'brick', i1: i, j1: 0, i2: i, j2: 1, s: 0 });
  const inner = { id: id++, type: 'wall', mat: 'brick', i1: 1, j1: 0, i2: 1, j2: 1, s: 0 };
  const m = buildModel(upgradeDesign({ pieces: [...walls, inner], pointLoads: [] }), { wind: 30, windDir: 0 });
  const fx = (x) => m.nodes.reduce((acc, n, k) => acc + (Math.abs(n.x - x) < 1e-6 ? m.FT[k * 6] : 0), 0);
  const q = 0.5 * 1.2 * 30 ** 2, A = 2 * 3;
  close(fx(0), 0.8 * q * A, 1e-9);           // windward wall: pressure, Cp +0.8
  assert.equal(fx(2), 0, 'sheltered wall');   // inner wall: shielded both ways
  close(fx(4), 0.5 * q * A, 1e-9);           // leeward wall: suction, Cp −0.5, same direction
});

test('re-analysis after members break: PCG matches a fresh factorisation', async () => {
  const { PRESETS } = await import('../public/engine/presets.js');
  const m = buildModel(PRESETS.find((p) => p.id === 'office').design(), { wind: 40 });
  const a = new Structure(m), b = new Structure(m);
  const act = new Uint8Array(a.ne).fill(1);
  a.solve(act, a.reach(act)); // factorise the intact structure
  for (let i = 0; i < a.ne; i += 37) act[i] = 0; // knock out a scattering of members
  a.settle(act, new Int32Array(a.np).fill(-1), 1);
  const seen = a.reach(act);
  const s1 = a.solve(act, seen), s2 = b.solve(act, seen);
  assert.ok(a.stats.factorisations === 1, 'second solve reused the factor');
  let err = 0, mag = 0;
  for (let k = 0; k < s1.uT.length; k++) { err = Math.max(err, Math.abs(s1.uT[k] - s2.uT[k])); mag = Math.max(mag, Math.abs(s2.uT[k])); }
  assert.ok(err < 1e-6 * mag, `max diff ${err} vs ${mag}`);
});

// ---- Fine grid (0.5 m) ------------------------------------------------------------------
const box = (mat, i0, j0, i1, j1, s, type = 'wall') => {
  const out = [];
  for (let i = i0; i < i1; i++) out.push({ type, mat, i1: i, j1: j0, i2: i + 1, j2: j0, s }, { type, mat, i1: i, j1: j1, i2: i + 1, j2: j1, s });
  for (let j = j0; j < j1; j++) out.push({ type, mat, i1: i0, j1: j, i2: i0, j2: j + 1, s }, { type, mat, i1: i1, j1: j, i2: i1, j2: j + 1, s });
  return out;
};
const withIds = (list) => ({ grid: 0.5, pieces: list.map((p, k) => ({ id: k + 1, ...p })), pointLoads: [] });

test('fine grid: a 3.5 × 2.5 m shed off the 2 m lines stands, panels stay ≤ 2 m', () => {
  const pieces = [...box('timber', 1, 1, 8, 6, 0)];
  for (let i = 1; i < 8; i++) for (let j = 1; j < 6; j++) pieces.push({ type: 'slab', mat: 'timber', i, j, s: 0 });
  pieces.push({ type: 'roof', mat: 'steel', i0: 1, j0: 1, i1: 8, j1: 6, s: 1, axis: 'x', pitch: 25 });
  pieces.push(...box('timber', 1, 1, 8, 6, 1));
  const m = buildModel(withIds(pieces));
  for (const e of m.elems) if (e.role === 'wall edge') {
    const a = m.nodes[e.n1], b = m.nodes[e.n2];
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) <= 2 + 1e-9, 'panel wider than 2 m');
  }
  const r = new Structure(m).run({ deadOnly: true });
  assert.equal(r.summary.unsupported, 0);
  assert.equal(r.summary.failedCount, 0, JSON.stringify(r.summary.firstDamage));
});

test('fine grid: a floor spanning onto an off-grid interior wall is held up by it', () => {
  // 6 m × 2 m room, brick, concrete floor; interior wall at x = 2.5 m (not on a 2 m line).
  const pieces = [...box('brick', 0, 0, 12, 4, 0)];
  for (let j = 0; j < 4; j++) pieces.push({ type: 'wall', mat: 'brick', i1: 5, j1: j, i2: 5, j2: j + 1, s: 0 });
  for (let i = 0; i < 12; i++) for (let j = 0; j < 4; j++) pieces.push({ type: 'slab', mat: 'concrete', i, j, s: 0 });
  const m = buildModel(withIds(pieces));
  // No floor rectangle may straddle the interior wall line.
  for (const e of m.elems) if (e.role === 'floor edge') {
    const xs = [m.nodes[e.n1].x, m.nodes[e.n2].x];
    assert.ok(!(Math.min(...xs) < 2.5 - 1e-9 && Math.max(...xs) > 2.5 + 1e-9), 'floor edge crosses the wall');
  }
  const s = new Structure(m);
  const act = new Uint8Array(s.ne).fill(1);
  const sol = s.solve(act, s.reach(act));
  // The interior wall really carries floor load: its studs are in compression.
  const studs = m.elems.filter((e) => e.role === 'wall edge' && Math.abs(m.nodes[e.n1].x - 2.5) < 1e-9 && m.nodes[e.n1].x === m.nodes[e.n2].x && m.nodes[e.n1].z === m.nodes[e.n2].z);
  assert.ok(studs.length >= 2);
  const N = studs.reduce((acc, e) => acc + s.describe(e.id, sol, 0).N, 0);
  assert.ok(N < -5e3, `interior wall axial ${N}`);
  const r = s.run({ deadOnly: true });
  assert.equal(r.summary.unsupported, 0);
});

test('fine grid: an old 2 m design upgrades to the same structure', () => {
  // The presets are written on the old 2 m grid; the villa had 52 joints and 300 members before.
  const d = PRESETS.find((p) => p.id === 'villa').design();
  assert.equal(d.grid, 0.5);
  const m = buildModel(d);
  assert.equal(m.nodes.length, 52);
  assert.equal(m.elems.length, 300);
});

test('cross bracing stiffens an open column frame against sideways load', () => {
  const frame = [];
  for (const [i, j] of [[0, 0], [4, 0], [0, 4], [4, 4]]) frame.push({ type: 'column', mat: 'steel', i, j, s: 0 });
  for (let i = 0; i < 4; i++) frame.push({ type: 'beam', mat: 'steel', i1: i, j1: 0, i2: i + 1, j2: 0, s: 0 }, { type: 'beam', mat: 'steel', i1: i, j1: 4, i2: i + 1, j2: 4, s: 0 });
  for (let j = 0; j < 4; j++) frame.push({ type: 'beam', mat: 'steel', i1: 0, j1: j, i2: 0, j2: j + 1, s: 0 }, { type: 'beam', mat: 'steel', i1: 4, j1: j, i2: 4, j2: j + 1, s: 0 });
  const sway = (pieces) => {
    const d = withIds(pieces);
    d.pointLoads = [{ x: 0, y: 3, z: 0, fx: 10, fy: 0, fz: 0 }];
    const s = new Structure(buildModel(d));
    const act = new Uint8Array(s.ne).fill(1);
    const sol = s.solve(act, s.reach(act));
    const m = s.m, id = m.nodes.findIndex((n) => n.x === 0 && n.y === 3 && n.z === 0);
    return Math.abs(sol.uT[6 * id]);
  };
  const braced = [...frame];
  for (let j = 0; j < 4; j++) braced.push({ type: 'brace', mat: 'steel', i1: 0, j1: j, i2: 0, j2: j + 1, s: 0 }, { type: 'brace', mat: 'steel', i1: 4, j1: j, i2: 4, j2: j + 1, s: 0 });
  for (let i = 0; i < 4; i++) braced.push({ type: 'brace', mat: 'steel', i1: i, j1: 0, i2: i + 1, j2: 0, s: 0 }, { type: 'brace', mat: 'steel', i1: i, j1: 4, i2: i + 1, j2: 4, s: 0 });
  const a = sway(frame), b = sway(braced);
  assert.ok(b < a / 10, `braced ${b} vs open ${a}`);
});

test('a ground slab (floor of the ground storey) sits on the ground and upsets nothing', () => {
  const pieces = [...box('brick', 0, 0, 8, 6, 0)];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 6; j++) pieces.push({ type: 'slab', mat: 'concrete', i, j, s: -1 });
  const m = buildModel(withIds(pieces), { live: 2 });
  assert.ok(m.nodes.every((n) => n.y > 0 || n.fixed));
  const r = new Structure(m).run({});
  assert.equal(r.summary.unsupported, 0);
  assert.equal(r.summary.failedCount, 0);
  assert.ok(r.frames.every((f) => Number.isFinite(f.maxDisp)));
});

test('hip roofs stand on every preset, including a square plan (pyramid) and an odd 3.5 m span', () => {
  for (const p of PRESETS) {
    const d = p.design();
    if (!d.pieces.some((q) => q.type === 'roof')) continue;
    d.pieces.forEach((q) => { if (q.type === 'roof') q.style = 'hip'; });
    const r = new Structure(buildModel(d)).run({ deadOnly: true });
    assert.equal(r.summary.failedCount, 0, `${p.name}: ${JSON.stringify(r.summary.firstDamage)}`);
    assert.equal(r.summary.unsupported, 0, p.name);
  }
  for (const [w, h] of [[8, 8], [7, 9], [3, 3]]) {
    const pieces = [...box('timber', 0, 0, w, h, 0), { type: 'roof', mat: 'timber', i0: 0, j0: 0, i1: w, j1: h, s: 0, axis: w >= h ? 'x' : 'z', pitch: 30, style: 'hip' }];
    const r = new Structure(buildModel(withIds(pieces))).run({ deadOnly: true });
    assert.equal(r.summary.failedCount, 0, `${w}×${h}: ${JSON.stringify(r.summary.firstDamage)}`);
    assert.equal(r.summary.unsupported, 0, `${w}×${h}`);
  }
});

test('a hip roof holds on in wind longer than the same house with a gable', () => {
  for (const id of ['hut', 'bungalow']) {
    const lam = (style) => {
      const d = PRESETS.find((p) => p.id === id).design();
      d.pieces.forEach((q) => { if (q.type === 'roof') q.style = style; });
      return new Structure(buildModel(d, { wind: 40 })).run({ push: true }).summary.firstDamage.lam;
    };
    assert.ok(lam('hip') > lam('gable'), id);
  }
});

test('challenges: each one can be won with a sensible build, and the obvious cheap mistake loses', async () => {
  const { CHALLENGES, loadCases, score } = await import('../public/engine/challenges.js');
  // A house with a 1 m door on the south side and a 2 m window on the north.
  const ring = (type, mat, w, h, s) => {
    const out = [];
    const S = (i) => (i === 3 || i === 4 ? 'door' : type), N = (i) => (i >= 2 && i < 6 ? 'window' : type);
    for (let i = 0; i < w; i++) out.push({ type: S(i), mat, i1: i, j1: 0, i2: i + 1, j2: 0, s }, { type: N(i), mat, i1: i, j1: h, i2: i + 1, j2: h, s });
    for (let j = 0; j < h; j++) out.push({ type, mat, i1: 0, j1: j, i2: 0, j2: j + 1, s }, { type, mat, i1: w, j1: j, i2: w, j2: j + 1, s });
    return out;
  };
  const roof = (mat, w, h, s) => ({ type: 'roof', mat, i0: 0, j0: 0, i1: w, j1: h, s, axis: w >= h ? 'x' : 'z', pitch: 30, style: 'hip' });
  const attempt = (id, pieces) => {
    const ch = CHALLENGES.find((c) => c.id === id), d = withIds(pieces);
    const sums = loadCases(ch).map((L) => new Structure(buildModel(d, L)).run({}).summary);
    return score(ch, d, buildModel(d).totals.cost, sums);
  };
  assert.ok(attempt('starter', [...ring('wall', 'brick', 12, 10, 0), roof('brick', 12, 10, 0)]).stars >= 2);
  assert.ok(attempt('tulbagh', [...ring('wall', 'timber', 12, 10, 0), roof('timber', 12, 10, 0)]).stars >= 2);
  const brickQuake = attempt('tulbagh', [...ring('wall', 'brick', 12, 10, 0), roof('brick', 12, 10, 0)]);
  assert.equal(brickQuake.stars, 0, 'unreinforced brick should not survive Tulbagh');
  assert.ok(brickQuake.fell);
  const tooSmall = attempt('starter', [...ring('wall', 'brick', 6, 6, 0), roof('brick', 6, 6, 0)]);
  assert.equal(tooSmall.stars, 0);
  assert.deepEqual(tooSmall.missing, ['30 m² under roof']);
});

test('a long window is one opening: 6 m of glass in brick cracks, a concrete lintel or a steel frame spans it', () => {
  const house = (mat, lintel) => {
    const pieces = box(mat, 0, 0, 16, 12, 0).map((p) => (p.j1 === 0 && p.j2 === 0 && p.i1 >= 2 && p.i2 <= 14 ? { ...p, type: 'window' } : p));
    pieces.push({ type: 'roof', mat: 'brick', i0: 0, j0: 0, i1: 16, j1: 12, s: 0, axis: 'x', pitch: 30 });
    if (lintel) for (let i = 0; i < 16; i++) pieces.push({ type: 'beam', mat: lintel, i1: i, j1: 0, i2: i + 1, j2: 0, s: 0 });
    return buildModel(withIds(pieces));
  };
  const brick = house('brick');
  assert.ok(!brick.elems.some((e) => e.role === 'wall shear strut' && brick.nodes[e.n1].z === 0 && brick.nodes[e.n2].z === 0 &&
    Math.min(brick.nodes[e.n1].x, brick.nodes[e.n2].x) >= 1.5 && Math.max(brick.nodes[e.n1].x, brick.nodes[e.n2].x) <= 6.5), 'no struts inside the opening');
  assert.ok(new Structure(brick).run({ deadOnly: true }).summary.failedCount > 0);
  assert.equal(new Structure(house('steel')).run({ deadOnly: true }).summary.failedCount, 0);
  assert.equal(new Structure(house('brick', 'concrete')).run({ deadOnly: true }).summary.failedCount, 0);
});
