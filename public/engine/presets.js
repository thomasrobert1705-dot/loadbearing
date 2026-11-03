// Ready-made houses to start from (and to test the engine with).
// They're laid out on the original 2 m grid and split onto the fine grid by upgradeDesign().
import { upgradeDesign } from './model.js';

function builder() {
  const pieces = [];
  let id = 1;
  const add = (p) => { pieces.push({ id: id++, ...p }); };
  const api = {
    pieces,
    column: (mat, i, j, s) => add({ type: 'column', mat, i, j, s }),
    beam: (mat, i1, j1, i2, j2, s) => add({ type: 'beam', mat, i1, j1, i2, j2, s }),
    panel: (type, mat, i1, j1, i2, j2, s) => add({ type, mat, i1, j1, i2, j2, s }),
    slab: (mat, i, j, s) => add({ type: 'slab', mat, i, j, s }),
    roof: (mat, i0, j0, i1, j1, s, axis = 'x', pitch = 30) => add({ type: 'roof', mat, i0, j0, i1, j1, s, axis, pitch }),
    // Perimeter walls of a rectangle; `open(edgeIndex, side)` returns 'window' / 'door' / 'wall'.
    walls(mat, i0, j0, i1, j1, s, open = () => 'wall') {
      let k = 0;
      for (let i = i0; i < i1; i++) api.panel(open(k++, 'S', i), mat, i, j0, i + 1, j0, s);
      for (let j = j0; j < j1; j++) api.panel(open(k++, 'E', j), mat, i1, j, i1, j + 1, s);
      for (let i = i1; i > i0; i--) api.panel(open(k++, 'N', i), mat, i, j1, i - 1, j1, s);
      for (let j = j1; j > j0; j--) api.panel(open(k++, 'W', j), mat, i0, j, i0, j - 1, s);
    },
    slabs(mat, i0, j0, i1, j1, s) {
      for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) api.slab(mat, i, j, s);
    },
    perimeterBeams(mat, i0, j0, i1, j1, s) {
      for (let i = i0; i < i1; i++) { api.beam(mat, i, j0, i + 1, j0, s); api.beam(mat, i, j1, i + 1, j1, s); }
      for (let j = j0; j < j1; j++) { api.beam(mat, i0, j, i0, j + 1, s); api.beam(mat, i1, j, i1, j + 1, s); }
    },
    gridColumns(mat, i0, j0, i1, j1, s, step = 1) {
      for (let i = i0; i <= i1; i += step) for (let j = j0; j <= j1; j += step) api.column(mat, i, j, s);
    },
  };
  return api;
}

export const PRESETS = [
  {
    id: 'bungalow', name: 'Brick bungalow',
    blurb: 'Typical SA face-brick house: 8 × 6 m, clay-tile roof on timber trusses.',
    design() {
      const b = builder();
      b.walls('brick', -2, -2, 2, 1, 0, (k, side, n) =>
        side === 'S' && n === 0 ? 'door' : (side === 'S' || side === 'N') && n !== 0 && n !== -1 ? 'window' : side === 'E' && n === -1 ? 'window' : 'wall');
      b.panel('wall', 'brick', 0, -2, 0, -1, 0);
      b.panel('door', 'brick', 0, -1, 0, 0, 0);
      b.panel('wall', 'brick', 0, 0, 0, 1, 0);
      b.roof('brick', -2, -2, 2, 1, 0, 'x', 30);
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'timber2', name: 'Timber double-storey',
    blurb: 'Light timber frame: CLT walls and floor, two storeys, steep roof.',
    design() {
      const b = builder();
      b.walls('timber', -1, -1, 2, 2, 0, (k, side, n) => (side === 'S' && n === 0 ? 'door' : k % 2 ? 'window' : 'wall'));
      b.slabs('timber', -1, -1, 2, 2, 0);
      b.walls('timber', -1, -1, 2, 2, 1, (k) => (k % 2 ? 'window' : 'wall'));
      b.roof('timber', -1, -1, 2, 2, 1, 'x', 40);
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'office', name: 'Steel & glass office',
    blurb: 'Three-storey steel frame, concrete floors, glass façades. No shear walls!',
    design() {
      const b = builder();
      for (let s = 0; s < 3; s++) {
        b.gridColumns('steel', -2, -1, 2, 1, s);
        for (let j = -1; j <= 1; j++) for (let i = -2; i < 2; i++) b.beam('steel', i, j, i + 1, j, s);
        for (let i = -2; i <= 2; i++) for (let j = -1; j < 1; j++) b.beam('steel', i, j, i, j + 1, s);
        b.slabs('concrete', -2, -1, 2, 1, s);
        b.walls('aluminium', -2, -1, 2, 1, s, (k, side, n) => (s === 0 && side === 'S' && n === 0 ? 'door' : 'window'));
      }
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'villa', name: 'Concrete villa',
    blurb: 'Two storeys of reinforced concrete, flat roof, big windows.',
    design() {
      const b = builder();
      const open = (s) => (k, side, n) => (s === 0 && side === 'S' && n === 0 ? 'door' : side === 'S' || side === 'N' ? 'window' : 'wall');
      b.walls('concrete', -2, -1, 2, 2, 0, open(0));
      // Interior wall straight under the upper storey's end wall: loads go straight down.
      b.panel('wall', 'concrete', 1, -1, 1, 0, 0);
      b.panel('door', 'concrete', 1, 0, 1, 1, 0);
      b.panel('wall', 'concrete', 1, 1, 1, 2, 0);
      b.slabs('concrete', -2, -1, 2, 2, 0);
      b.walls('concrete', -2, -1, 1, 2, 1, open(1));
      b.slabs('concrete', -2, -1, 1, 2, 1);
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'stilts', name: 'Bamboo stilt house',
    blurb: 'Bamboo room on bamboo poles with a thatched roof. Watch the open ground storey.',
    design() {
      const b = builder();
      b.gridColumns('bamboo', -1, -1, 1, 1, 0);
      b.perimeterBeams('bamboo', -1, -1, 1, 1, 0);
      b.beam('bamboo', -1, 0, 0, 0, 0); b.beam('bamboo', 0, 0, 1, 0, 0);
      b.beam('bamboo', 0, -1, 0, 0, 0); b.beam('bamboo', 0, 0, 0, 1, 0);
      b.slabs('bamboo', -1, -1, 1, 1, 0);
      b.walls('bamboo', -1, -1, 1, 1, 1, (k, side, n) => (side === 'S' && n === -1 ? 'door' : k % 2 ? 'window' : 'wall'));
      b.roof('bamboo', -1, -1, 1, 1, 1, 'x', 40);
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'hut', name: 'Rammed-earth cottage',
    blurb: 'Thick earth walls, thatched timber roof. Cheap, cosy, brittle.',
    design() {
      const b = builder();
      b.walls('earth', -1, -1, 1, 1, 0, (k, side, n) => (side === 'S' && n === -1 ? 'door' : side === 'E' || side === 'W' ? 'window' : 'wall'));
      b.roof('earth', -1, -1, 1, 1, 0, 'x', 35);
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'tower', name: 'Little skyscraper',
    blurb: 'Ten storeys, 30 m: a steel frame with glass curtain walls around a concrete lift core. The core is what keeps it up in wind.',
    design() {
      const b = builder();
      const N = 10;
      for (let s = 0; s < N; s++) {
        b.gridColumns('steel', -1, -1, 2, 2, s);
        for (let j = -1; j <= 2; j++) for (let i = -1; i < 2; i++) b.beam('steel', i, j, i + 1, j, s);
        for (let i = -1; i <= 2; i++) for (let j = -1; j < 2; j++) b.beam('steel', i, j, i, j + 1, s);
        b.slabs('concrete', -1, -1, 2, 2, s);
        b.walls('glass', -1, -1, 2, 2, s, (k, side, n) => (s === 0 && side === 'S' && n === 0 ? 'door' : 'window'));
        // Lift core: the middle bay, walled in concrete all the way up.
        b.walls('concrete', 0, 0, 1, 1, s, (k, side) => (side === 'S' ? 'door' : 'wall'));
      }
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'capedutch', name: 'Cape Dutch farmhouse',
    blurb: 'Long, low brick farmhouse with a steep thatched roof and cross walls. Thick walls and small windows: fine in wind, nervous in a quake.',
    design() {
      const b = builder();
      b.walls('brick', -4, -1, 4, 1, 0, (k, side, n) =>
        side === 'S' && n === 0 ? 'door' : (side === 'S' || side === 'N') && n % 2 !== 0 ? 'window' : 'wall');
      for (const i of [-2, 2]) { b.panel('wall', 'brick', i, -1, i, 0, 0); b.panel('door', 'brick', i, 0, i, 1, 0); }
      b.roof('earth', -4, -1, 4, 1, 0, 'x', 45);
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'warehouse', name: 'Steel warehouse',
    blurb: 'Steel columns and roof trusses, thin aluminium cladding, X-bracing in the end bays. Take a brace out and try the wind again.',
    design() {
      const b = builder();
      for (let s = 0; s < 2; s++) {
        for (let i = -3; i <= 3; i++) for (const j of [-2, 2]) b.column('steel', i, j, s);
        for (const i of [-3, 3]) for (let j = -1; j <= 1; j++) b.column('steel', i, j, s);
        b.perimeterBeams('steel', -3, -2, 3, 2, s);
        for (let i = -3; i < 3; i++) for (const j of [-2, 2]) {
          const brace = (i === -3 || i === 2) && s === 0;
          b.panel(brace ? 'brace' : s === 0 && j === -2 && i === 0 ? 'door' : 'wall', brace ? 'steel' : 'aluminium', i, j, i + 1, j, s);
        }
        for (const i of [-3, 3]) for (let j = -2; j < 2; j++) {
          const brace = (j === -2 || j === 1) && s === 0;
          b.panel(brace ? 'brace' : 'wall', brace ? 'steel' : 'aluminium', i, j, i, j + 1, s);
        }
      }
      b.roof('steel', -3, -2, 3, 2, 1, 'x', 15);
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'chapel', name: 'Sandstone chapel',
    blurb: 'Two-storey-high sandstone nave with no floor between, under a steep slate roof. Heavy stone is great in compression and hopeless in tension.',
    design() {
      const b = builder();
      for (let s = 0; s < 2; s++) {
        b.walls('stone', -1, -3, 1, 3, s, (k, side, n) =>
          s === 0 && side === 'S' && n === -1 ? 'door' : s === 1 && (side === 'E' || side === 'W') && n % 2 === 0 ? 'window' : 'wall');
      }
      b.roof('stone', -1, -3, 1, 3, 1, 'z', 50);
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'pavilion', name: 'Glass pavilion',
    blurb: 'Structural-glass walls under a flat glulam roof, on a concrete slab. Surprisingly tough: stiff glass walls are great shear walls. Find what breaks it.',
    design() {
      const b = builder();
      b.slabs('concrete', -2, -2, 2, 2, -1);
      b.walls('glass', -2, -2, 2, 2, 0, (k, side, n) => (side === 'S' && n === 0 ? 'door' : 'wall'));
      b.perimeterBeams('glulam', -2, -2, 2, 2, 0);
      for (let i = -1; i <= 1; i++) for (let j = -2; j < 2; j++) b.beam('glulam', i, j, i, j + 1, 0);
      b.slabs('glulam', -2, -2, 2, 2, 0);
      return { pieces: b.pieces, pointLoads: [] };
    },
  },
  {
    id: 'empty', name: 'Empty plot', blurb: 'Start from scratch.',
    design() { return { pieces: [], pointLoads: [] }; },
  },
];

for (const p of PRESETS) {
  const legacy = p.design;
  p.design = () => upgradeDesign({ grid: 2, ...legacy() });
}
