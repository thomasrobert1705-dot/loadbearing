// Runs the structural analysis off the main thread.
import { buildModel } from './engine/model.js';
import { Structure } from './engine/solver.js';

self.onmessage = ({ data }) => {
  const { id, kind, design, loads, push } = data;
  try {
    const t0 = performance.now();
    const model = buildModel(design, kind === 'check' ? {} : loads);
    const s = new Structure(model);
    const r = s.run(kind === 'check' ? { deadOnly: true } : { push });
    self.postMessage({ id, kind, frames: r.frames, summary: r.summary, totals: model.totals, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, kind, error: String(err?.stack || err) });
  }
};
