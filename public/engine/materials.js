// Materials and member sections.
//
// Units throughout the engine are SI: metres, newtons, pascals, kilograms.
// Strengths are characteristic (unfactored) values — the simulator shows the
// moment a member actually breaks, not when a design code would reject it.
//
// A section has: A (area), Iy / Iz (second moments about local y / z),
// J (torsion constant), Sy / Sz (elastic section moduli), plus the outer
// dimensions b (along local z) and h (along local y) for drawing.

export const CELL = 0.5;   // horizontal build-grid spacing (m)
export const STOREY = 3;   // storey height (m)
export const G_ACC = 9.81;

export function rect(b, h) {
  const [s, l] = b < h ? [b, h] : [h, b];
  const r = s / l;
  const J = l * s ** 3 * (1 / 3 - 0.21 * r * (1 - r ** 4 / 12));
  return {
    kind: 'rect', b, h, A: b * h,
    Iz: (b * h ** 3) / 12, Iy: (h * b ** 3) / 12, J,
    Sz: (b * h ** 2) / 6, Sy: (h * b ** 2) / 6,
  };
}

export function box(b, h, t) {
  const bi = b - 2 * t, hi = h - 2 * t;
  const Iz = (b * h ** 3 - bi * hi ** 3) / 12;
  const Iy = (h * b ** 3 - hi * bi ** 3) / 12;
  const J = (2 * t * (b - t) ** 2 * (h - t) ** 2) / (b - t + (h - t));
  return { kind: 'box', b, h, t, A: b * h - bi * hi, Iz, Iy, J, Sz: Iz / (h / 2), Sy: Iy / (b / 2) };
}

export function tube(D, t) {
  const R = D / 2, r = R - t;
  const I = (Math.PI * (R ** 4 - r ** 4)) / 4;
  return { kind: 'tube', b: D, h: D, t, A: Math.PI * (R * R - r * r), Iz: I, Iy: I, J: 2 * I, Sz: I / R, Sy: I / R };
}

// E: Young's modulus, rho: density, fc/ft/fv: compressive / tensile / shear strength,
// cost: rough South African supply-and-build cost per m³ of material (ZAR, 2026-ish),
// wallT / slabT: thickness of solid wall and floor panels, cladding: roof covering (kPa),
// claddingCost: R per m² of roof covering, anchor: uplift capacity of one rafter's hold-down (N),
// roofFrame: what the roof structure is made of when it isn't the material itself (nobody builds brick rafters).
export const MATERIALS = {
  timber: {
    name: 'Timber', blurb: 'SA pine framing and CLT panels. Light, decent in tension and bending, soft-ish.',
    color: 0xc89a5e, E: 10e9, rho: 500, fc: 22e6, ft: 14e6, fv: 2.5e6, cost: 11000,
    column: rect(0.15, 0.15), beam: rect(0.076, 0.228), wallT: 0.1, slabT: 0.15,
    cladding: 0.2, claddingCost: 350, roofColor: 0x7a5232, anchor: 4e3, brace: rect(0.05, 0.152),
  },
  glulam: {
    name: 'Glulam', blurb: 'Glued-laminated engineered timber. Bigger, stronger and stiffer than sawn pine, still light.',
    color: 0xd9b27a, E: 13e9, rho: 460, fc: 28e6, ft: 20e6, fv: 3.5e6, cost: 24000,
    column: rect(0.2, 0.2), beam: rect(0.115, 0.36), wallT: 0.12, slabT: 0.16,
    cladding: 0.2, claddingCost: 450, roofColor: 0x6b4a2e, anchor: 6e3, brace: rect(0.09, 0.18),
  },
  steel: {
    name: 'Steel', blurb: 'S355 hollow sections and plate. Very strong, heavy, slender members can buckle.',
    color: 0x8a96a3, E: 200e9, rho: 7850, fc: 355e6, ft: 355e6, fv: 205e6, cost: 260000,
    column: box(0.15, 0.15, 0.006), beam: box(0.1, 0.2, 0.006), wallT: 0.004, slabT: 0.012,
    cladding: 0.1, claddingCost: 220, roofColor: 0x5d6b78, anchor: 15e3, brace: tube(0.076, 0.004),
  },
  concrete: {
    name: 'Reinforced concrete', blurb: 'Concrete with rebar. Stiff, heavy, strong in compression.',
    color: 0xb9b6ad, E: 30e9, rho: 2400, fc: 30e6, ft: 5e6, fv: 2.5e6, cost: 6000,
    column: rect(0.25, 0.25), beam: rect(0.23, 0.45), wallT: 0.15, slabT: 0.17,
    cladding: 0.55, claddingCost: 300, roofColor: 0x6e6c68, anchor: 20e3, brace: rect(0.15, 0.15),
  },
  brick: {
    name: 'Brick masonry', blurb: 'Unreinforced clay brick. Great in compression, cracks easily in tension.',
    color: 0xb5532f, E: 6e9, rho: 1900, fc: 7e6, ft: 0.5e6, fv: 0.4e6, cost: 2800,
    column: rect(0.23, 0.34), beam: rect(0.23, 0.34), wallT: 0.22, slabT: 0.2,
    cladding: 0.65, claddingCost: 380, roofColor: 0x9c3b22, anchor: 3e3, brace: rect(0.23, 0.23),
    roofFrame: 'timber', roofName: 'clay tiles on timber trusses',
  },
  stone: {
    name: 'Sandstone', blurb: 'Dressed sandstone blocks, Free State style. Thick, heavy, strong in compression, brittle in tension.',
    color: 0xcdb894, E: 12e9, rho: 2300, fc: 15e6, ft: 0.35e6, fv: 0.3e6, cost: 5200,
    column: rect(0.45, 0.45), beam: rect(0.4, 0.45), wallT: 0.45, slabT: 0.2,
    cladding: 0.85, claddingCost: 900, roofColor: 0x4f5359, anchor: 3e3, brace: rect(0.3, 0.3),
    roofFrame: 'timber', roofName: 'slate on timber trusses',
  },
  aluminium: {
    name: 'Aluminium', blurb: '6061 alloy. A third of steel\'s weight and stiffness. Pricey.',
    color: 0xd2d8de, E: 69e9, rho: 2700, fc: 200e6, ft: 240e6, fv: 140e6, cost: 330000,
    column: box(0.15, 0.15, 0.008), beam: box(0.1, 0.25, 0.008), wallT: 0.004, slabT: 0.012,
    cladding: 0.08, claddingCost: 420, roofColor: 0xa9b3bc, anchor: 10e3, brace: tube(0.076, 0.005),
  },
  bamboo: {
    name: 'Bamboo', blurb: 'Hollow culms: light and remarkably strong for their weight.',
    color: 0xc9b458, E: 18e9, rho: 700, fc: 45e6, ft: 60e6, fv: 5e6, cost: 5000,
    column: tube(0.14, 0.014), beam: tube(0.14, 0.014), wallT: 0.05, slabT: 0.08,
    cladding: 0.3, claddingCost: 150, roofColor: 0x9a8a3c, anchor: 2.5e3, brace: tube(0.1, 0.01),
  },
  earth: {
    name: 'Rammed earth', blurb: 'Compacted soil. Cheap and thick, weak in tension and shear.',
    color: 0xa9825a, E: 1.5e9, rho: 1900, fc: 2e6, ft: 0.12e6, fv: 0.15e6, cost: 1600,
    column: rect(0.4, 0.4), beam: rect(0.35, 0.35), wallT: 0.35, slabT: 0.25,
    cladding: 0.4, claddingCost: 120, roofColor: 0x8b7a4a, anchor: 2.5e3, brace: rect(0.3, 0.3),
    roofFrame: 'timber', roofName: 'thatch on timber poles',
  },
  glass: {
    name: 'Structural glass', blurb: 'Laminated toughened glass: walls, fins and floors you can see through. Stiff, strong, and shatters without warning.',
    color: 0xbfe3ec, E: 70e9, rho: 2500, fc: 250e6, ft: 60e6, fv: 30e6, cost: 90000,
    column: rect(0.05, 0.25), beam: rect(0.04, 0.3), wallT: 0.024, slabT: 0.05,
    cladding: 0.6, claddingCost: 2500, roofColor: 0x9fc6d4, anchor: 8e3, brace: rect(0.04, 0.2),
  },
  carbon: {
    name: 'Carbon fibre', blurb: 'CFRP tubes and skins, race-car style. Absurdly strong for its weight. Absurdly expensive.',
    color: 0x3a3f45, E: 70e9, rho: 1600, fc: 400e6, ft: 600e6, fv: 60e6, cost: 2000000,
    column: tube(0.12, 0.004), beam: box(0.08, 0.18, 0.004), wallT: 0.008, slabT: 0.035,
    cladding: 0.05, claddingCost: 1500, roofColor: 0x2b2f33, anchor: 12e3, brace: tube(0.05, 0.003),
  },
};

export const MATERIAL_IDS = Object.keys(MATERIALS);
export const POISSON = 0.25;

// Panel modelling constants (the "equivalent diagonal strut" idea used for masonry infill).
export const PANEL = {
  edgeDepth: 0.3,      // depth of the strip of wall acting as top / bottom "beam"
  sideWidth: 0.4,      // half-width strip at each vertical edge (adjacent panels add to a full strip)
  strutFactor: 0.15,   // diagonal strut width as a fraction of the diagonal length
  slabStrip: 0.5,      // width of slab acting as the edge "beam" (each side of a shared edge)
  opening: { wall: 0, window: 0.3, door: 0.35 },          // fraction of panel area that is a hole
  strutScale: { wall: 1, window: 0.2, door: 0.1 },        // openings interrupt the diagonal strut
  glazingKPa: 0.3,
  glazingCost: 1800,   // R / m²
  doorCost: 4500,      // R per door
  finishesKPa: 0.5,    // screed / ceiling under every floor slab
};

export const LOAD_DEFAULTS = { live: 1.5, snow: 0, wind: 0, windDir: 0, quake: 0, quakeDir: 0 };
