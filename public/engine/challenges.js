// Challenges: a brief, a budget and a hazard. Your current build is tested against the hazard
// from two directions (so bracing it only one way doesn't count) and scored out of three stars:
//   ★     nothing fell down, within budget and the brief
//   ★★    not a single member broke
//   ★★★   undamaged and at most 75% of the budget
import { CELL } from './materials.js';

export const CHALLENGES = [
  {
    id: 'braai', name: 'Braai shelter', icon: '🔥',
    brief: 'A roof over the braai: at least 9 m² of cover that survives a Highveld thunderstorm.',
    lesson: 'Four posts and a roof is a mechanism sideways. Bracing, or a few walls, turns it into a structure.',
    budget: 25000, req: { roofArea: 9 }, loads: { live: 0, wind: 30 },
  },
  {
    id: 'starter', name: 'Starter home', icon: '🏠',
    brief: 'A first home with at least 30 m² under roof that rides out a Cape of Storms gale.',
    lesson: 'Roofs usually go first in wind: suction lifts them off. Hip roofs and heavy coverings hold on longer.',
    budget: 90000, req: { roofArea: 30 }, loads: { live: 0.5, wind: 40 },
  },
  {
    id: 'chalet', name: 'Drakensberg chalet', icon: '🏔️',
    brief: 'A mountain chalet, at least 24 m² under roof, carrying a heavy 2 kPa snowfall.',
    lesson: 'Snow is weight on the rafters. Steeper pitches shed load into the walls; long spans need deeper members.',
    budget: 100000, req: { roofArea: 24 }, loads: { live: 0.5, snow: 2 },
  },
  {
    id: 'tulbagh', name: 'Tulbagh rebuild', icon: '🌍',
    brief: 'Rebuild after the 1969 quake: at least 30 m² under roof, surviving 0.3 g of shaking.',
    lesson: 'Earthquake force is proportional to weight. Heavy unreinforced masonry suffers; light, tied-together frames do well.',
    budget: 130000, req: { roofArea: 30 }, loads: { live: 0.5, quake: 0.3 },
  },
  {
    id: 'party', name: 'Upstairs party', icon: '🎉',
    brief: 'A double-storey with an upper floor of at least 20 m² that takes a packed party (5 kPa).',
    lesson: 'Floor loads gather as they go down: the ground-floor walls carry everything above them.',
    budget: 180000, req: { storeys: 2, upperFloorArea: 20 }, loads: { live: 5 },
  },
  {
    id: 'family', name: 'Family home, quake zone', icon: '👪',
    brief: 'Two storeys, at least 30 m² upstairs, roofed, through a 0.25 g earthquake with people at home.',
    lesson: 'Upper storeys swing further. Walls running both ways, and floors tying them together, keep it boxy.',
    budget: 280000, req: { storeys: 2, upperFloorArea: 30, roofArea: 30 }, loads: { live: 1.5, quake: 0.25 },
  },
  {
    id: 'tornado', name: 'Tornado alley', icon: '🌪️',
    brief: 'A safe room with at least 24 m² under roof that is still standing after an EF4 tornado (85 m/s).',
    lesson: 'At 85 m/s the wind pressure is about 4 kPa: as if a car were parked on every 3 m² of wall.',
    budget: 150000, req: { roofArea: 24 }, loads: { live: 0, wind: 85 },
  },
];

const area = (n) => n * CELL * CELL;

// What the design offers, measured the way the briefs ask.
export function measure(design) {
  let roof = 0, floor = 0, upper = 0, storeys = 0;
  for (const p of design.pieces) {
    if (p.type === 'roof') roof += area((p.i1 - p.i0) * (p.j1 - p.j0));
    if (p.type === 'slab') { floor += area(1); if (p.s >= 0) upper += area(1); }
    if (['wall', 'window', 'door', 'column', 'brace'].includes(p.type)) storeys = Math.max(storeys, p.s + 1);
  }
  return { roofArea: roof, floorArea: floor, upperFloorArea: upper, storeys };
}

export const REQ_TEXT = {
  roofArea: (v) => `${v} m² under roof`,
  upperFloorArea: (v) => `${v} m² of upper floor`,
  floorArea: (v) => `${v} m² of floor`,
  storeys: (v) => `${v} storeys`,
};

// The load cases a challenge is tested with: wind and quakes from two directions at right angles.
export function loadCases(ch) {
  const base = { live: 0, snow: 0, wind: 0, windDir: 0, quake: 0, quakeDir: 0, ...ch.loads };
  if (base.wind || base.quake) return [0, 90].map((d) => ({ ...base, windDir: d, quakeDir: d }));
  return [base];
}

// summaries: one solver summary per load case (from a normal 0–100% run, not push).
export function score(ch, design, cost, summaries) {
  const got = measure(design);
  const missing = Object.entries(ch.req).filter(([k, v]) => got[k] < v - 1e-9).map(([k, v]) => REQ_TEXT[k](v));
  const overBudget = cost > ch.budget;
  const fell = summaries.some((s) => s.fallenFrac > 0 || s.unsupported > 0 || s.collapseLam);
  const broke = summaries.some((s) => s.failedCount > 0);
  let stars = 0;
  if (!missing.length && !overBudget && !fell) stars = broke ? 1 : cost <= 0.75 * ch.budget ? 3 : 2;
  return { stars, got, missing, overBudget, fell, broke };
}
