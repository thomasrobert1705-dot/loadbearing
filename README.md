# Loadbearing: a house building simulator

**Play it in your browser: https://thomasrobert1705-dot.github.io/loadbearing/**

Build a house in 3D from eleven materials, then put it under people, snow, wind, earthquakes and point
loads. A real structural solver works out how every joint moves and which members break. Then you watch it
bend, crack and (maybe) fall down.

```sh
npm start            # http://127.0.0.1:3070  (PORT / HOST env vars to change)
npm test             # solver checked against textbook answers + preset sanity checks
```

No npm dependencies. Three.js r160 is vendored in `public/vendor/`. All analysis runs in the browser (in a
Web Worker). The server only serves files. Your design autosaves in the browser's localStorage, and
Export / Import saves it as JSON.

## Studio visuals

The interface pairs a dark studio sidebar with a landscaped 3D site, soft sun shadows,
physical materials and locally generated brick, timber, roof and concrete textures.
No external fonts, image downloads or additional runtime dependencies are needed.

Use **3D**, **Top** and **Front** above the plot to change camera views; the crosshair
button fits the current building in view. The project overview tracks pieces, weight
and estimated materials. On narrow screens, the building tools sit below the viewport.
The game opens in Inspect mode so the complete house is visible; select a build tool to edit.

## Playing

- **Build:** pick a tool (1–9, 0) and a material, click or drag on the 0.5 m grid (stronger lines every 2 m). Storeys are 3 m (Q / E to move
  between them). Walls, columns, windows and doors fill the active storey. Floors are the floor you stand on
  at that level (a ground slab on the ground floor). Beams and roofs sit on top of the storey. Placing over a piece swaps its material. **Brace** adds X bracing to an open bay between columns. Roofs come as **gable** or **hip** (H toggles). Right-drag orbits, middle-drag / Shift + right-drag / arrow keys pan. The status chip runs a live self-weight check after
  every edit and flags anything with no path down to the ground.
- **Test loads:** choose a scenario (Highveld storm, Tulbagh 1969 quake, EF4 tornado…) or set the sliders.
  Add point loads by clicking joints. **Run test** ramps the loads 0 → 100%. **Push to collapse** keeps
  going until half the house is down and reports the load factor it reached. Scrub the timeline, or click
  an event in the log to jump to it.

## How the physics works

`public/engine/` is plain ES modules, shared by the browser and the Node tests.

| File | What it does |
| --- | --- |
| `materials.js` | E, density, strengths, sections, rough rand costs for the 11 materials |
| `model.js` | design → structural panels → nodes, 3D frame elements, load vectors (dead `FD`, test `FT`), render parts |
| `solver.js` | direct stiffness method, member checks, progressive collapse |
| `presets.js` | the sample houses |

- **Fine grid, coarse structure:** you build on a 0.5 m grid, but the analysis merges runs of the same
  wall into panels of up to 2 m (split wherever a column or cross wall meets them), floors into rectangles
  of up to 2 × 2 m that never straddle a wall line, and roofs get a truss roughly every 2 m. Horizontal
  members at the same level are then joined wherever they cross or a joint sits on them. Each small piece
  is still drawn, hovered and erased on its own as a slice of its panel.
- **Elements:** 12-DOF Euler–Bernoulli frame members, axial-only struts, and pinned members (moment
  releases by static condensation, used for rafters and the ends of ceiling ties).
- **Cross bracing** is two pinned diagonals plus top and bottom chords. It needs columns at both ends.
- **Walls** are four edge strips plus two diagonal struts (the equivalent-strut model for infill). Window
  and door panels get much weaker struts. **Floors** are edge strips plus diagonals, so they act as
  diaphragms. **Roofs** are rafters, ridge, eaves, ceiling ties and slope bracing, plus a ceiling
  diaphragm. Brick and earth roofs mean clay tiles or thatch on a *timber* frame.
- **Solve:** banded Cholesky with reverse Cuthill–McKee numbering. After members break, the old factor is
  reused as a preconditioner for conjugate gradients, because breaking a member is a low-rank change to K.
  It refactorises only when CG stalls. That made collapse runs about 15× faster.
- **Checks:** tension, crushing + Euler buckling (Rankine–Gordon), bending, shear, roof tie-down uplift, and
  an instability catch (drift > L/15 or > 0.4 m). When members pass 100% they break, load redistributes, and
  the structure is re-analysed at the same load level. Anything not connected to the ground falls as a
  rigid body.
- **Loads:** self-weight is always on at 100%. Live load and snow (kPa) go on floors and roofs. Wind uses
  q = ½ρv² with Cp +0.8 windward / −0.5 leeward (ray-cast shielding) and −0.8 roof uplift. Earthquake is
  equivalent static: V = 2.5 × PGA × W, distributed by mass × height.

## Limits (it's a teaching model)

Linear-elastic, small-displacement analysis. No dynamics: earthquake shaking in the view is cosmetic, and the
forces are equivalent static. Strengths are unfactored, and walls and floors are strips and struts rather
than plates. Connections are rigid apart from the roof. Foundations are fixed and never fail. Big buildings
(over ~1,000 joints) take a minute or more to analyse.

## Decisions

- 2026-11-03: Structural solver (stiffness method) instead of a rigid-body game engine, so stresses are
  meaningful. Grid-snapped pieces, laptop browser first.
- 2026-11-03: Rafters pinned and ceiling ties pinned at the eaves. Rigid roof joints put unrealistic moments
  into brick walls (they failed under self-weight).
- 2026-11-03: Added a ceiling diaphragm. Without it, gable walls were 3 m cantilevers and failed in
  ordinary wind.
- 2026-11-03: Earthquake behaviour factor R = 1 (elastic) after calibrating the presets. Brick bungalow
  cracks around 0.25 g and collapses around 0.35–0.4 g. The rammed-earth cottage goes at about 0.2 g.
- 2026-11-03: Roof tie-down straps have per-material uplift capacity (timber 4 kN per rafter), so light roofs
  blow off at about 45–50 m/s, before the walls go. Heavier tile roofs hold on longer, as in real storms.
- 2026-11-03: Window and door panels contribute 20% and 10% of a solid wall's racking strut. Glass façades
  shouldn't brace a building.
- 2026-11-03: Fixed DOF numbering plus PCG with the previous factor for re-analysis (60 s → 4 s on an
  8×6×4 building).
- 2026-11-03: Build grid refined from 2 m to 0.5 m. The structure is still meshed at up to 2 m panels:
  meshing at 0.5 m would have made analysis roughly 100× slower and pushed walls far outside the panel
  proportions the strut model was calibrated for. The presets give identical joints, members and failure
  loads to before. Old saves and exports (no `grid` field) are split onto the fine grid on load.
- 2026-11-03: Added glulam, sandstone, structural glass and carbon fibre, plus cross bracing. Masonry and
  thin metal-plate floors fail under their own weight in the timber double-storey: that's physics, not a
  bug (stone doesn't span).
- 2026-11-03: The Floor tool places the floor *of* the active storey (it used to place its ceiling, so
  "Ground floor" put the slab at 3 m). Internally a slab is still the top of the storey below; a ground
  slab is `s: -1` and sits on fixed joints.
- 2026-11-03: Hip roofs: four doubled hip rafters, commons on the ~2 m stations and a fan of rafters at each hip
  end (feet on panel corners, so the wall model isn't loaded mid-panel), each with a tie behind it. Each rafter
  gets the plan area it really supports and one full tie-down strap. Suction Cp 0.65 (gable 0.8), and gable
  end triangles now catch wind. Result: a hip roof holds on 10–40% longer in wind than the same gable house.
