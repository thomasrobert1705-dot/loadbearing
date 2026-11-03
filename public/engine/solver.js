// Linear-elastic 3D frame analysis with progressive failure.
//
// Method (the "direct stiffness method", what structural analysis programs do under the hood):
//   1. every member gets a 12×12 stiffness matrix (6 degrees of freedom at each end:
//      3 translations + 3 rotations; Euler–Bernoulli beam theory),
//   2. they are rotated into global axes and added into one big matrix K,
//   3. K·u = F is solved for the joint displacements u (banded Cholesky, joints renumbered
//      with reverse Cuthill–McKee to keep the band narrow),
//   4. member end forces come back out, and every member is checked against its material:
//      tension, compression (Rankine–Gordon: crushing and Euler buckling combined),
//      bending stress and shear.
//
// Progressive collapse: loads are ramped up (dead load stays at 100%, the test loads go
// from 0% → 100%, or further when pushing to collapse). When members exceed 100% utilisation
// the worst ones break, the structure is re-analysed with the load redistributed, and anything
// no longer connected to the ground (or whose own rules say it can't stand) falls.
//
// Because the analysis is linear, the solution for any load level λ is uD + λ·uT, so one
// factorisation gives every load level until the structure changes.

import { POISSON, G_ACC } from './materials.js';

const MODES = ['ok', 'tension', 'crushing', 'buckling', 'bending', 'shear', 'unstable', 'uplift'];
export { MODES };
const MAX_SHOWN_DISP = 0.5; // m: past the 0.4 m instability limit, so anything moving this far is failing

export class Structure {
  constructor(model) {
    this.m = model;
    const { nodes, elems, parts } = model;
    this.nn = nodes.length;
    this.ne = elems.length;
    this.np = parts.length;
    this.geo = elems.map((e) => geometry(nodes[e.n1], nodes[e.n2], e.vy));
    this.wl = elems.map((e, i) => ({ D: rot(this.geo[i].R, e.wD), T: rot(this.geo[i].R, e.wT) }));
    this.kl = [];
    this.fe = [];
    elems.forEach((e, i) => {
      const L = this.geo[i].L;
      const k = localK(e, L);
      const fD = feq(this.wl[i].D, L, e.truss), fT = feq(this.wl[i].T, L, e.truss);
      // Moment releases ("pins") at either end: condense those rotations out.
      const rel = [];
      if (!e.truss && (e.pinned || e.release?.[0])) rel.push(4, 5);
      if (!e.truss && (e.pinned || e.release?.[1])) rel.push(10, 11);
      if (rel.length) condense(k, [fD, fT], rel);
      this.kl.push(k);
      this.fe.push({ D: fD, T: fT });
    });
    // Mass of each part, used for "how much of the house fell down".
    this.partMass = parts.map((p) => {
      let m = p.extraMass || 0;
      for (const id of p.elems) m += ((p.share ?? 1) * -elems[id].wD[1] * this.geo[id].L) / G_ACC;
      return m;
    });
    this.totalMass = this.partMass.reduce((a, b) => a + b, 0) || 1;
    this.nodeParts = Array.from({ length: this.nn }, () => []);
    parts.forEach((p, i) => p.nodes.forEach((n) => this.nodeParts[n].push(i)));
    this.hasTest = model.FT.some((v) => v !== 0) || elems.some((e) => e.wT.some((v) => v !== 0));
  }

  // Which nodes are connected to the ground through active frame members?
  reach(active) {
    const { nodes, elems } = this.m;
    const adj = Array.from({ length: this.nn }, () => []);
    for (let i = 0; i < this.ne; i++) {
      if (!active[i] || elems[i].truss) continue;
      adj[elems[i].n1].push(elems[i].n2);
      adj[elems[i].n2].push(elems[i].n1);
    }
    const seen = new Uint8Array(this.nn);
    const q = [];
    nodes.forEach((n, i) => { if (n.fixed) { seen[i] = 1; q.push(i); } });
    while (q.length) {
      const a = q.pop();
      for (const b of adj[a]) if (!seen[b]) { seen[b] = 1; q.push(b); }
    }
    return seen;
  }

  // Apply consequences of failures until nothing more changes:
  // members hanging off unreachable joints go, parts whose rules trip fall.
  settle(active, fallen, frameNo) {
    const { elems, parts, nodes } = this.m;
    const newly = [];
    for (let guard = 0; guard < 1000; guard++) {
      const seen = this.reach(active);
      let changed = false;
      for (let i = 0; i < this.ne; i++) {
        if (active[i] && (!seen[elems[i].n1] || !seen[elems[i].n2])) { active[i] = 0; changed = true; }
      }
      for (let p = 0; p < this.np; p++) {
        if (fallen[p] >= 0) continue;
        const part = parts[p];
        let falls = part.nodes.some((n) => !nodes[n].fixed && !seen[n]);
        if (!falls) for (const r of part.rules) {
          let c = 0;
          for (const id of r.ids) if (Array.isArray(id) ? id.some((x) => !active[x]) : !active[id]) c++;
          if (c >= r.k) { falls = true; break; }
        }
        if (falls) {
          fallen[p] = frameNo;
          newly.push(p);
          for (const id of part.elems) if (active[id]) active[id] = 0;
          changed = true;
        }
      }
      if (!changed) return { seen, newly };
    }
    return { seen: this.reach(active), newly };
  }

  // Fixed joint numbering for the whole model (RCM ordering keeps the matrix band narrow), and
  // element matrices / load vectors pre-rotated into global axes.
  prepare() {
    if (this.pos) return;
    const { nodes, elems } = this.m;
    const adj = Array.from({ length: this.nn }, () => []);
    for (const e of elems) { adj[e.n1].push(e.n2); adj[e.n2].push(e.n1); }
    const order = rcm(this.nn, adj, (i) => !nodes[i].fixed && adj[i].length > 0);
    this.pos = new Int32Array(this.nn).fill(-1);
    order.forEach((nd, k) => { this.pos[nd] = k; });
    this.order = order;
    this.n = order.length * 6;
    let hb = 5;
    for (const e of elems) {
      const a = this.pos[e.n1], b = this.pos[e.n2];
      if (a >= 0 && b >= 0) hb = Math.max(hb, Math.abs(a - b) * 6 + 5);
    }
    this.hb = hb;
    this.kg = elems.map((e, i) => { const k = new Float64Array(144); toGlobal(this.kl[i], this.geo[i].R, k); return k; });
    this.gD = elems.map((e, i) => blockRotT(this.geo[i].R, this.fe[i].D));
    this.gT = elems.map((e, i) => blockRotT(this.geo[i].R, this.fe[i].T));
    this.dofs = elems.map((e) => dofMap(this.pos[e.n1], this.pos[e.n2]));
    this.stats = { factorisations: 0, pcgIterations: 0, solves: 0 };
  }

  // Solve both load cases for the current set of active members.
  // The first call factorises K. Later calls (after members break) reuse that factor as a
  // preconditioner for conjugate gradients: removing a few members is a low-rank change to K,
  // so CG converges in a few iterations. If it doesn't, we refactorise.
  solve(active, seen) {
    this.prepare();
    const { nodes, FD, FT } = this.m;
    const n = this.n, hb = this.hb, w = hb + 1, pos = this.pos;
    const K = (this.Kbuf ??= new Float64Array(Math.max(1, n * w)));
    K.fill(0);
    const rD = new Float64Array(n), rT = new Float64Array(n);
    this.order.forEach((nd, k) => {
      if (!seen[nd]) return;
      for (let d = 0; d < 6; d++) { rD[k * 6 + d] += FD[nd * 6 + d]; rT[k * 6 + d] += FT[nd * 6 + d]; }
    });
    for (let i = 0; i < this.ne; i++) {
      if (!active[i]) continue;
      const kg = this.kg[i], dofs = this.dofs[i], gD = this.gD[i], gT = this.gT[i];
      for (let r = 0; r < 12; r++) {
        const gr = dofs[r];
        if (gr < 0) continue;
        rD[gr] += gD[r]; rT[gr] += gT[r];
        for (let c = 0; c < 12; c++) {
          const gc = dofs[c];
          if (gc < gr) continue;
          K[gr * w + (gc - gr)] += kg[r * 12 + c];
        }
      }
    }
    // Tiny regularisation so joints held only by struts don't make K singular; joints that
    // have fallen away keep a decoupled diagonal so the numbering never changes.
    if (this.eps === undefined) {
      let maxDiag = 0;
      for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, K[i * w]);
      this.eps = maxDiag * 1e-10 + 1e-6;
    }
    for (let k = 0; k < this.order.length; k++) {
      const off = !seen[this.order[k]];
      for (let d = 0; d < 6; d++) {
        const i = k * 6 + d;
        K[i * w] += this.eps;
        if (off) K[i * w] = this.F0diag ? this.F0diag[i] : 1;
      }
    }

    this.stats.solves++;
    let xD = null, xT = null;
    if (this.F) {
      xD = pcg(K, n, hb, rD, this.lastD, this.F, 40, this.stats);
      xT = xD && pcg(K, n, hb, rT, this.lastT, this.F, 40, this.stats);
    }
    if (!xD || !xT) {
      this.F = K.slice();
      this.F0diag = new Float64Array(n);
      for (let i = 0; i < n; i++) this.F0diag[i] = K[i * w];
      cholBand(this.F, n, hb);
      this.stats.factorisations++;
      xD = rD.slice(); xT = rT.slice();
      solveBand(this.F, n, hb, xD);
      solveBand(this.F, n, hb, xT);
    }
    this.lastD = xD; this.lastT = xT;

    const uD = new Float64Array(this.nn * 6), uT = new Float64Array(this.nn * 6);
    this.order.forEach((nd, k) => {
      if (!seen[nd]) return;
      for (let d = 0; d < 6; d++) { uD[nd * 6 + d] = xD[k * 6 + d]; uT[nd * 6 + d] = xT[k * 6 + d]; }
    });
    const elems = this.m.elems;

    // Member end forces (local axes) for each load case: f = k·u_local − f_eq.
    const fD = new Float64Array(this.ne * 12), fT = new Float64Array(this.ne * 12);
    for (let i = 0; i < this.ne; i++) {
      if (!active[i]) continue;
      const e = elems[i], R = this.geo[i].R, L = this.geo[i].L;
      for (const [u, out, fe] of [[uD, fD, this.fe[i].D], [uT, fT, this.fe[i].T]]) {
        const ug = new Float64Array(12);
        for (let d = 0; d < 6; d++) { ug[d] = u[e.n1 * 6 + d]; ug[6 + d] = u[e.n2 * 6 + d]; }
        const ul = blockRot(R, ug);
        const k = this.kl[i];
        for (let r = 0; r < 12; r++) {
          let s = 0;
          for (let c = 0; c < 12; c++) s += k[r * 12 + c] * ul[c];
          out[i * 12 + r] = s - fe[r];
        }
      }
    }
    return { uD, uT, fD, fT };
  }

  // Utilisation of member i at load level lam (1.0 = exactly at breaking point).
  check(i, sol, lam, out) {
    const e = this.m.elems[i], s = e.sec, L = this.geo[i].L;
    const f = new Float64Array(12);
    for (let r = 0; r < 12; r++) f[r] = sol.fD[i * 12 + r] + lam * sol.fT[i * 12 + r];
    const wD = this.wl[i].D, wT = this.wl[i].T;
    const wy = wD[1] + lam * wT[1], wz = wD[2] + lam * wT[2];
    const N1 = -f[0], N2 = f[6];
    const Nt = Math.max(N1, N2), Nc = -Math.min(N1, N2);
    let util, mode, Mmax = 0, V = 0;

    if (e.truss) {
      const sT = Math.max(0, Nt) / s.A / e.ft, sC = Math.max(0, Nc) / s.A / e.fc;
      util = Math.max(sT, sC);
      mode = sT >= sC ? 1 : 2;
    } else {
      const Mz = maxAbsMoment(-f[5], f[1], wy, L);
      const My = maxAbsMoment(f[4], f[2], wz, L);
      Mmax = Math.hypot(My, Mz);
      const sb = My / s.Sy + Mz / s.Sz;
      V = Math.max(Math.hypot(f[1], f[2]), Math.hypot(f[7], f[8]));
      const uV = (1.5 * V) / s.A / e.fv;
      const uT = Math.max(0, Nt / s.A + sb) / e.ft;
      let uC, cMode;
      if (Nc > 0) {
        const Pcr = e.buckle ? (Math.PI ** 2 * e.E * Math.min(s.Iy, s.Iz)) / (L * L) : Infinity;
        const crush = Nc / (e.fc * s.A), buck = Nc / Pcr, bend = sb / e.fc;
        uC = crush + buck + bend;
        cMode = buck >= crush && buck >= bend ? 3 : bend > crush ? 4 : 2;
      } else {
        uC = Math.max(0, sb - Nt / s.A) / e.fc;
        cMode = 4;
      }
      util = uT; mode = sb > Math.max(0, Nt / s.A) ? 4 : 1;
      if (uC > util) { util = uC; mode = cMode; }
      if (uV > util) { util = uV; mode = 5; }
    }
    // Roof straps: the node pulling the rafter foot downward means the strap is in tension.
    if (e.anchor) {
      const R = this.geo[i].R;
      const gy = R[0][1] * f[0] + R[1][1] * f[1] + R[2][1] * f[2];
      const uA = Math.max(0, -gy) / e.anchor;
      if (uA > util) { util = uA; mode = 7; }
    }
    // A linear analysis can't see a mechanism or a member flopping about; treat a drift of
    // more than L/15 between the member's ends (or 0.4 m anywhere) as having lost stability.
    const u = sol.uD, t = sol.uT, a = e.n1 * 6, b = e.n2 * 6;
    let rel = 0, abs = 0;
    for (let d = 0; d < 3; d++) {
      const ua = u[a + d] + lam * t[a + d], ub = u[b + d] + lam * t[b + d];
      rel += (ua - ub) ** 2; abs = Math.max(abs, Math.abs(ua), Math.abs(ub));
    }
    const uS = Math.max(Math.sqrt(rel) / (L / 15), abs / 0.4);
    if (uS > util) { util = uS; mode = 6; }
    if (out) { out.N = Math.abs(Nt) > Math.abs(Nc) ? Nt : -Nc; out.M = Mmax; out.V = V; }
    return { util, mode };
  }

  // Run a load test. Returns frames for playback plus a summary.
  //   opts.push   – keep increasing the test loads past 100% until the house collapses
  //   opts.steps  – load increments between 0 and 100%
  run(opts = {}) {
    const steps = opts.steps ?? 20;
    const push = !!opts.push && this.hasTest;
    const lamMax = opts.deadOnly ? 0 : 1;
    const active = new Uint8Array(this.ne).fill(1);
    const fallen = new Int32Array(this.np).fill(-1);
    const failedAt = new Float32Array(this.ne).fill(-1);
    const failMode = new Uint8Array(this.ne);
    const frames = [];
    const events = [];
    let firstDamage = null;
    let lastU = new Float32Array(this.nn * 3);

    let { seen, newly } = this.settle(active, fallen, 0);
    const unsupported = newly.slice();
    let sol = this.solve(active, seen);

    const utilAt = (lam) => {
      const u = new Float32Array(this.ne), md = new Uint8Array(this.ne), n = new Float32Array(this.ne);
      let max = 0, arg = -1;
      const out = {};
      for (let i = 0; i < this.ne; i++) {
        if (!active[i]) continue;
        const r = this.check(i, sol, lam, out);
        u[i] = r.util; md[i] = r.mode; n[i] = out.N;
        if (r.util > max) { max = r.util; arg = i; }
      }
      return { u, md, n, max, arg };
    };

    const record = (lam, ut, failedNow, fallenNow, failedModes = []) => {
      const U = new Float32Array(this.nn * 3);
      let maxDisp = 0;
      for (let i = 0; i < this.nn; i++) {
        if (seen[i]) {
          for (let d = 0; d < 3; d++) U[i * 3 + d] = sol.uD[i * 6 + d] + lam * sol.uT[i * 6 + d];
          const disp = Math.hypot(U[i * 3], U[i * 3 + 1], U[i * 3 + 2]);
          // Just after something breaks, a piece can briefly be a mechanism and the linear solve
          // says it moved kilometres. Its members fail the instability check (0.4 m) and it falls
          // in the next step; until then, hold it where it last was instead of drawing a spike.
          if (disp > MAX_SHOWN_DISP) for (let d = 0; d < 3; d++) U[i * 3 + d] = lastU[i * 3 + d];
          else maxDisp = Math.max(maxDisp, disp);
        } else {
          for (let d = 0; d < 3; d++) U[i * 3 + d] = lastU[i * 3 + d];
        }
      }
      lastU = U;
      const partUtil = new Float32Array(this.np), partMode = new Uint8Array(this.np);
      this.m.parts.forEach((p, k) => {
        let mx = 0, md = 0;
        for (const id of p.elems) if (active[id] && ut.u[id] > mx) { mx = ut.u[id]; md = ut.md[id]; }
        partUtil[k] = mx; partMode[k] = md;
      });
      let fallenMass = 0;
      for (let p = 0; p < this.np; p++) if (fallen[p] >= 0) fallenMass += this.partMass[p];
      frames.push({ lam, U, maxDisp, partUtil, partMode, elemUtil: ut.u, elemMode: ut.md, elemN: ut.n,
        active: active.slice(), failed: failedNow, failedModes, fell: fallenNow, fallenFrac: fallenMass / this.totalMass });
    };

    const lams = [];
    for (let k = 0; k <= steps; k++) lams.push((k / steps) * lamMax);
    if (opts.deadOnly) lams.length = 1;

    let prevLam = 0, prevMax = 0, iter = 0, collapseLam = null;
    let ut = utilAt(0);
    record(0, ut, [], unsupported);

    const processAt = (lam) => {
      // Break members, redistribute, repeat until stable at this load level.
      for (let round = 0; round < 400; round++) {
        ut = utilAt(lam);
        if (ut.max <= 1) return;
        if (firstDamage === null) firstDamage = { lam, elem: ut.arg, mode: ut.md[ut.arg] };
        // Early on, break only the worst members and let load redistribute; once a cascade is
        // clearly under way, break everything that is overloaded at once.
        const thr = round < 4 ? Math.max(1, ut.max * 0.92) : 1;
        const failedNow = [];
        for (let i = 0; i < this.ne; i++) {
          if (active[i] && ut.u[i] >= thr) {
            active[i] = 0; failedAt[i] = lam; failMode[i] = ut.md[i]; failedNow.push(i);
          }
        }
        events.push({ lam, elems: failedNow.map((i) => ({ i, mode: ut.md[i], util: ut.u[i] })) });
        const modes = failedNow.map((i) => ut.md[i]);
        const st = this.settle(active, fallen, frames.length);
        seen = st.seen;
        sol = this.solve(active, seen);
        ut = utilAt(lam);
        record(lam, ut, failedNow, st.newly, modes);
        if (++iter > 600) return;
      }
    };

    processAt(0);
    let k = 1;
    let lam = lams[1] ?? 0;
    while (lams.length > 1) {
      if (k < lams.length) lam = lams[k];
      else if (push) lam = lam < 3 ? lam + 0.1 : lam * 1.08;
      else break;

      const t = utilAt(lam);
      if (t.max > 1 && prevMax <= 1 && lam > prevLam) {
        // Find the exact load level where the first member hits 100% (bisection).
        let lo = prevLam, hi = lam;
        for (let b = 0; b < 30; b++) {
          const mid = (lo + hi) / 2;
          if (utilAt(mid).max > 1) hi = mid; else lo = mid;
        }
        ut = utilAt(hi);
        record(hi, ut, [], []);
        processAt(hi * 1.0001);
      }
      processAt(lam);
      ut = utilAt(lam);
      record(lam, ut, [], []);
      prevLam = lam; prevMax = ut.max;
      const fr = frames[frames.length - 1].fallenFrac;
      if (push && collapseLam === null && fr >= 0.5) { collapseLam = lam; break; }
      if (push && lam > 50) break;
      if (iter > 600) break;
      k++;
    }

    const last = frames[frames.length - 1];
    let worst = -1, worstU = 0;
    for (let i = 0; i < this.ne; i++) if (last.active[i] && last.elemUtil[i] > worstU) { worstU = last.elemUtil[i]; worst = i; }
    const failedCount = failedAt.reduce((a, v) => a + (v >= 0 ? 1 : 0), 0);
    return {
      frames, events,
      summary: {
        hasTest: this.hasTest, push, finalLam: last.lam,
        firstDamage: firstDamage && { ...firstDamage, piece: this.m.elems[firstDamage.elem].piece, role: this.m.elems[firstDamage.elem].role, mat: this.m.elems[firstDamage.elem].mat },
        worst: worst >= 0 ? { util: worstU, mode: last.elemMode[worst], piece: this.m.elems[worst].piece, role: this.m.elems[worst].role, mat: this.m.elems[worst].mat } : null,
        failedCount, fallenFrac: last.fallenFrac, collapseLam,
        maxDisp: Math.max(...frames.map((f) => (f.fallenFrac < 0.01 ? f.maxDisp : 0))),
        unsupported: unsupported.length,
        fallenParts: Array.from(fallen).filter((v) => v >= 0).length,
      },
    };
  }

  // Detailed numbers for one member at a frame (for the hover tooltip).
  describe(i, sol, lam) {
    const out = {};
    const r = this.check(i, sol, lam, out);
    return { ...r, ...out };
  }
}

// ---- helpers ------------------------------------------------------------------------------

function geometry(a, b, vy) {
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  const L = Math.hypot(...d);
  const ex = d.map((v) => v / L);
  let ref = vy;
  if (Math.abs(ex[0] * ref[0] + ex[1] * ref[1] + ex[2] * ref[2]) > 0.99) ref = Math.abs(ex[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  let ez = cross(ex, ref);
  const nz = Math.hypot(...ez);
  ez = ez.map((v) => v / nz);
  const ey = cross(ez, ex);
  return { L, R: [ex, ey, ez] };
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const rot = (R, v) => R.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

function blockRot(R, g) {
  const out = new Float64Array(12);
  for (let b = 0; b < 4; b++) for (let i = 0; i < 3; i++)
    out[b * 3 + i] = R[i][0] * g[b * 3] + R[i][1] * g[b * 3 + 1] + R[i][2] * g[b * 3 + 2];
  return out;
}
function blockRotT(R, l) {
  const out = new Float64Array(12);
  for (let b = 0; b < 4; b++) for (let j = 0; j < 3; j++)
    out[b * 3 + j] = R[0][j] * l[b * 3] + R[1][j] * l[b * 3 + 1] + R[2][j] * l[b * 3 + 2];
  return out;
}

// Global K block = Rᵀ k R for each of the 4×4 blocks of 3×3.
function toGlobal(k, R, out) {
  const tmp = new Float64Array(9);
  for (let bi = 0; bi < 4; bi++) for (let bj = 0; bj < 4; bj++) {
    // tmp = k_block · R
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let m = 0; m < 3; m++) s += k[(bi * 3 + i) * 12 + bj * 3 + m] * R[m][j];
      tmp[i * 3 + j] = s;
    }
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let m = 0; m < 3; m++) s += R[m][i] * tmp[m * 3 + j];
      out[(bi * 3 + i) * 12 + bj * 3 + j] = s;
    }
  }
}

function dofMap(p1, p2) {
  const d = new Int32Array(12);
  for (let k = 0; k < 6; k++) { d[k] = p1 >= 0 ? p1 * 6 + k : -1; d[6 + k] = p2 >= 0 ? p2 * 6 + k : -1; }
  return d;
}

export function localK(e, L) {
  const k = new Float64Array(144);
  const s = e.sec, E = e.E;
  const set = (i, j, v) => { k[i * 12 + j] += v; if (i !== j) k[j * 12 + i] += v; };
  const EA = (E * s.A) / L;
  set(0, 0, EA); set(0, 6, -EA); set(6, 6, EA);
  if (e.truss) return k;
  const G = E / (2 * (1 + POISSON));
  const GJ = (G * s.J) / L;
  set(3, 3, GJ); set(3, 9, -GJ); set(9, 9, GJ);
  const z = E * s.Iz, y = E * s.Iy, L2 = L * L, L3 = L2 * L;
  // bending in the local x–y plane (v, θz)
  set(1, 1, 12 * z / L3); set(1, 5, 6 * z / L2); set(1, 7, -12 * z / L3); set(1, 11, 6 * z / L2);
  set(5, 5, 4 * z / L); set(5, 7, -6 * z / L2); set(5, 11, 2 * z / L);
  set(7, 7, 12 * z / L3); set(7, 11, -6 * z / L2); set(11, 11, 4 * z / L);
  // bending in the local x–z plane (w, θy)
  set(2, 2, 12 * y / L3); set(2, 4, -6 * y / L2); set(2, 8, -12 * y / L3); set(2, 10, -6 * y / L2);
  set(4, 4, 4 * y / L); set(4, 8, 6 * y / L2); set(4, 10, 2 * y / L);
  set(8, 8, 12 * y / L3); set(8, 10, 6 * y / L2); set(10, 10, 4 * y / L);
  return k;
}

// Fixed-end (equivalent nodal) loads for a uniform load w (local axes, N/m).
// Static condensation: remove the released DOFs c (zero end moment there) from k and the
// fixed-end load vectors. k' = k_rr − k_rc·k_cc⁻¹·k_cr,  f' = f_r − k_rc·k_cc⁻¹·f_c.
function condense(k, fs, c) {
  const n = c.length;
  const A = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) A[i * n + j] = k[c[i] * 12 + c[j]];
  const inv = invert(A, n);
  const isC = new Uint8Array(12);
  for (const x of c) isC[x] = 1;
  const kc = new Float64Array(144);
  for (let r = 0; r < 12; r++) for (let s = 0; s < 12; s++) {
    if (isC[r] || isC[s]) continue;
    let v = k[r * 12 + s];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) v -= k[r * 12 + c[i]] * inv[i * n + j] * k[c[j] * 12 + s];
    kc[r * 12 + s] = v;
  }
  for (const f of fs) {
    const fc = c.map((x) => f[x]);
    const g = new Float64Array(12);
    for (let r = 0; r < 12; r++) {
      if (isC[r]) continue;
      let v = f[r];
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) v -= k[r * 12 + c[i]] * inv[i * n + j] * fc[j];
      g[r] = v;
    }
    f.set(g);
  }
  k.set(kc);
}
function invert(A, n) {
  const M = Float64Array.from(A), I = new Float64Array(n * n);
  for (let i = 0; i < n; i++) I[i * n + i] = 1;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r * n + col]) > Math.abs(M[piv * n + col])) piv = r;
    for (let j = 0; j < n; j++) {
      [M[col * n + j], M[piv * n + j]] = [M[piv * n + j], M[col * n + j]];
      [I[col * n + j], I[piv * n + j]] = [I[piv * n + j], I[col * n + j]];
    }
    const d = M[col * n + col] || 1e-30;
    for (let j = 0; j < n; j++) { M[col * n + j] /= d; I[col * n + j] /= d; }
    for (let r = 0; r < n; r++) if (r !== col) {
      const f = M[r * n + col];
      if (!f) continue;
      for (let j = 0; j < n; j++) { M[r * n + j] -= f * M[col * n + j]; I[r * n + j] -= f * I[col * n + j]; }
    }
  }
  return I;
}

function feq(w, L, noMoments) {
  const [wx, wy, wz] = w, h = L / 2, m = noMoments ? 0 : (L * L) / 12;
  return new Float64Array([
    wx * h, wy * h, wz * h, 0, -wz * m, wy * m,
    wx * h, wy * h, wz * h, 0, wz * m, -wy * m,
  ]);
}

// Largest |M(x)| along a member, M(x) = M0 + V0·x + w·x²/2.
function maxAbsMoment(M0, V0, w, L) {
  const at = (x) => Math.abs(M0 + V0 * x + (w * x * x) / 2);
  let m = Math.max(at(0), at(L));
  if (Math.abs(w) > 1e-12) {
    const xs = -V0 / w;
    if (xs > 0 && xs < L) m = Math.max(m, at(xs));
  }
  return m;
}

// Reverse Cuthill–McKee ordering of the nodes for which include(i) is true.
function rcm(n, adj, include) {
  const deg = new Int32Array(n);
  for (let i = 0; i < n; i++) deg[i] = adj[i].length;
  const visited = new Uint8Array(n);
  const nodes = [];
  for (let i = 0; i < n; i++) if (include(i)) nodes.push(i);
  nodes.sort((a, b) => deg[a] - deg[b]);
  const order = [];
  for (const start of nodes) {
    if (visited[start]) continue;
    visited[start] = 1;
    const q = [start];
    for (let h = 0; h < q.length; h++) {
      const v = q[h];
      order.push(v);
      const nb = adj[v].filter((u) => include(u) && !visited[u]);
      nb.sort((a, b) => deg[a] - deg[b]);
      for (const u of nb) if (!visited[u]) { visited[u] = 1; q.push(u); }
    }
  }
  return order.reverse();
}

// In-place banded Cholesky: A = Uᵀ·U, upper band stored row-wise, B[i*w + (j-i)].
function cholBand(B, n, hb) {
  const w = hb + 1;
  for (let i = 0; i < n; i++) {
    const kmin = Math.max(0, i - hb);
    let s = B[i * w];
    for (let k = kmin; k < i; k++) { const u = B[k * w + (i - k)]; s -= u * u; }
    const d = Math.sqrt(Math.max(s, 1e-12));
    B[i * w] = d;
    const jmax = Math.min(n - 1, i + hb);
    for (let j = i + 1; j <= jmax; j++) {
      let t = B[i * w + (j - i)];
      const k0 = Math.max(kmin, j - hb);
      for (let k = k0; k < i; k++) t -= B[k * w + (i - k)] * B[k * w + (j - k)];
      B[i * w + (j - i)] = t / d;
    }
  }
}
// Preconditioned conjugate gradients on the banded symmetric K, preconditioned by a previous
// Cholesky factor F. Returns null if it doesn't converge in maxIt iterations.
function pcg(K, n, hb, b, x0, F, maxIt, stats) {
  const w = hb + 1;
  let bn = 0;
  for (let i = 0; i < n; i++) bn += b[i] * b[i];
  if (bn === 0) return new Float64Array(n);
  const tol2 = bn * 1e-20;
  const x = x0 ? Float64Array.from(x0) : new Float64Array(n);
  const mul = (v, out) => {
    out.fill(0);
    for (let i = 0; i < n; i++) {
      const row = i * w, vi = v[i];
      let s = K[row] * vi;
      const jmax = Math.min(n - 1, i + hb);
      for (let j = i + 1; j <= jmax; j++) { const a = K[row + j - i]; if (a !== 0) { s += a * v[j]; out[j] += a * vi; } }
      out[i] += s;
    }
  };
  const r = new Float64Array(n), q = new Float64Array(n);
  mul(x, q);
  for (let i = 0; i < n; i++) r[i] = b[i] - q[i];
  let z = r.slice();
  solveBand(F, n, hb, z);
  const p = z.slice();
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  for (let it = 0; it < maxIt; it++) {
    let rr = 0;
    for (let i = 0; i < n; i++) rr += r[i] * r[i];
    if (rr <= tol2) return x;
    stats.pcgIterations++;
    mul(p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i] * q[i];
    if (!(pq > 0)) return null;
    const a = rz / pq;
    for (let i = 0; i < n; i++) { x[i] += a * p[i]; r[i] -= a * q[i]; }
    z = r.slice();
    solveBand(F, n, hb, z);
    let rz2 = 0;
    for (let i = 0; i < n; i++) rz2 += r[i] * z[i];
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  let rr = 0;
  for (let i = 0; i < n; i++) rr += r[i] * r[i];
  return rr <= tol2 ? x : null;
}

function solveBand(B, n, hb, x) {
  const w = hb + 1;
  for (let i = 0; i < n; i++) {
    let s = x[i];
    for (let k = Math.max(0, i - hb); k < i; k++) s -= B[k * w + (i - k)] * x[k];
    x[i] = s / B[i * w];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    const jmax = Math.min(n - 1, i + hb);
    for (let j = i + 1; j <= jmax; j++) s -= B[i * w + (j - i)] * x[j];
    x[i] = s / B[i * w];
  }
}
