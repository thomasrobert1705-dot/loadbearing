// Three.js scene: draws model parts in their deformed shape, ghosts for the build tools,
// falling debris with simple rigid-body physics, and weather effects.
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { addScenery, surfaceTexture } from './scenery.js';
import { MATERIALS, CELL } from './engine/materials.js';

export const GRID = 24;                // buildable area: grid lines -GRID..GRID (±12 m at 0.5 m)
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

const LOOKS = {
  glass: () => new THREE.MeshStandardMaterial({ color: 0x91c9c2, transparent: true, opacity: 0.55, roughness: 0.12, metalness: 0.25 }),
  door: () => new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.7 }),
};

export class Scene3D {
  constructor(container) {
    this.container = container;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    container.appendChild(r.domElement);

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0xd5ded0);
    scene.fog = new THREE.Fog(0xd5ded0, 45, 120);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    this.camera.position.set(23, 19, 26);
    const c = (this.controls = new OrbitControls(this.camera, r.domElement));
    c.target.set(0, 1.8, 0);
    c.enableDamping = true;
    c.maxPolarAngle = Math.PI * 0.495;
    c.minDistance = 4;
    c.maxDistance = 120;
    this.setLeftDrag(false);
    r.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    scene.add(new THREE.HemisphereLight(0xf2f6ed, 0x7d8b68, 2.0));
    const sun = (this.sun = new THREE.DirectionalLight(0xffedca, 3.0));
    sun.position.set(-12, 24, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80 });
    sun.shadow.radius = 3;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);

    // The world group shakes during earthquakes; the camera does not.
    this.world = new THREE.Group();
    scene.add(this.world);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0xa7b795, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.world.add(ground);
    const S = GRID * CELL * 2;
    const plot = new THREE.Mesh(new THREE.PlaneGeometry(S + 1, S + 1), new THREE.MeshStandardMaterial({ color: 0xd7d1b6, roughness: 1 }));
    plot.rotation.x = -Math.PI / 2;
    plot.position.y = 0.005;
    plot.receiveShadow = true;
    this.world.add(plot);

    addScenery(this.world, S);
    // Fine lines every CELL (0.5 m), stronger lines every 2 m so distances stay easy to read.
    this.grid = new THREE.Group();
    const fine = new THREE.GridHelper(S, GRID * 2, 0xa1ad8d, 0xa1ad8d);
    fine.material.transparent = true;
    fine.material.opacity = 0.16;
    const major = new THREE.GridHelper(S, Math.round(S / 2), 0x7c9275, 0x7c9275);
    major.material.transparent = true;
    major.material.opacity = 0.42;
    major.position.y = 0.002;
    this.grid.add(fine, major);
    this.world.add(this.grid);
    const levelPlane = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshBasicMaterial({ color: 0xa4d5ae, transparent: true, opacity: 0.10, depthWrite: false }));
    levelPlane.rotation.x = -Math.PI / 2;
    this.levelPlane = levelPlane;
    this.world.add(levelPlane);

    this.partsGroup = new THREE.Group();
    this.footings = new THREE.Group();
    this.ghostGroup = new THREE.Group();
    this.debrisGroup = new THREE.Group();
    this.loadsGroup = new THREE.Group();
    this.world.add(this.partsGroup, this.footings, this.ghostGroup, this.debrisGroup, this.loadsGroup);

    this.matCache = {};
    this.textureCache = {};
    this.parts = [];
    this.bodies = [];
    this.raycaster = new THREE.Raycaster();
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 14).rotateX(Math.PI / 2);
    this.makeWeather();

    this.onFrame = null;
    this.clock = new THREE.Clock();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    r.setAnimationLoop(() => this.tick());
  }

  setLeftDrag(orbit) {
    // Right-drag orbits, middle-drag (or Shift + right-drag) pans, the wheel zooms.
    this.controls.mouseButtons = { LEFT: orbit ? THREE.MOUSE.ROTATE : null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  }

  // Slide the view across the ground: dx to the right of the screen, dz away from you, as a
  // fraction of the current viewing distance.
  pan(dx, dz) {
    const c = this.controls, cam = this.camera;
    const fwd = new THREE.Vector3().subVectors(c.target, cam.position).setY(0);
    if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const d = cam.position.distanceTo(c.target);
    const move = right.multiplyScalar(dx * d).add(fwd.multiplyScalar(dz * d));
    c.target.add(move);
    cam.position.add(move);
    c.update();
  }

  setView(view = 'perspective') {
    const bounds = new THREE.Box3().setFromObject(this.partsGroup);
    const center = bounds.isEmpty() ? new THREE.Vector3(0, 1, 0) : bounds.getCenter(new THREE.Vector3());
    const extent = bounds.isEmpty() ? 10 : Math.max(...bounds.getSize(new THREE.Vector3()).toArray(), 8);
    const distance = Math.max(18, extent / (2 * Math.tan(this.camera.fov * Math.PI / 360)) / Math.min(1, this.camera.aspect) * 1.5);
    const direction = view === 'top' ? new THREE.Vector3(0, 1, .001) : view === 'front' ? new THREE.Vector3(0, .12, 1) : new THREE.Vector3(1, .8, 1.15);
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction.normalize(), distance);
    this.controls.update();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  tick() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.controls.update();
    if (this.onFrame) this.onFrame(dt);
    this.stepDebris(dt);
    this.stepWeather(dt);
    this.renderer.render(this.scene, this.camera);
  }

  setLevel(y, show = true) {
    this.grid.position.y = y + 0.01;
    this.levelPlane.position.y = y + 0.008;
    this.grid.visible = show;
    this.levelPlane.visible = show && y > 0;
  }

  // ---- materials -----------------------------------------------------------------------
  baseMaterial(mat, look) {
    if (look === 'glass' || look === 'door') return LOOKS[look]();
    const m = MATERIALS[mat];
    if (mat === 'glass') {
      return new THREE.MeshStandardMaterial({ color: look === 'roof' ? m.roofColor : m.color, transparent: true, opacity: 0.4, roughness: 0.06, metalness: 0.1 });
    }
    const palette = { brick: 0xba8060, timber: 0xcbb07c, concrete: 0xc4c5b9, earth: 0xbba47a, bamboo: 0xc5ba80 };
    const color = look === 'roof' ? (mat === 'brick' ? 0x775b4b : m.roofColor) : (palette[mat] ?? m.color);
    const metal = mat === 'steel' || mat === 'aluminium' || mat === 'carbon';
    const kind = look === 'roof' ? (metal ? 'metal' : 'tile') : ['brick', 'stone'].includes(mat) ? mat
      : ['timber', 'bamboo', 'glulam'].includes(mat) ? 'wood' : metal ? 'metal' : mat;
    const map = this.textureCache[kind] ??= surfaceTexture(kind, this.renderer);
    const metalness = mat === 'carbon' ? 0.3 : metal ? 0.65 : 0;
    return new THREE.MeshStandardMaterial({ color, map, bumpMap: map, bumpScale: metal ? .007 : .025, roughness: metal ? .4 : .92, metalness });
  }

  // ---- model visuals -----------------------------------------------------------------
  setModel(model, pieceStorey) {
    this.clearDebris();
    for (const p of this.parts) {
      for (const pr of p.prims) {
        pr.material.dispose();
        if (pr.prim.t !== 'bar') pr.mesh.geometry.dispose();
      }
      p.group.removeFromParent();
    }
    this.model = model;
    this.base = model.nodes.map((n) => [n.x, n.y, n.z]);
    this.parts = model.parts.map((part, idx) => {
      const group = new THREE.Group();
      const prims = part.prims.map((prim) => {
        const material = this.baseMaterial(part.mat, prim.look);
        material.userData.base = material.color.getHex();
        material.userData.opacity = material.opacity;
        let mesh;
        if (prim.t === 'bar') {
          mesh = new THREE.Mesh(prim.round ? this.cylGeo : this.boxGeo, material);
          mesh.matrixAutoUpdate = false;
        } else {
          const n = prim.t === 'quad' ? 36 : 24;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
          mesh = new THREE.Mesh(g, material);
        }
        mesh.castShadow = prim.look !== 'glass';
        mesh.receiveShadow = true;
        mesh.userData.part = idx;
        group.add(mesh);
        return { prim, mesh, material };
      });
      this.partsGroup.add(group);
      return { part, group, prims, storey: pieceStorey(part.piece), fallen: false };
    });
    // Foundation pads under every ground joint.
    for (const pad of this.footings.children) pad.material.dispose();
    this.footings.clear();
    const padMat = new THREE.MeshStandardMaterial({ color: 0x8c8a84, roughness: 1 });
    // Pads only where something stands on the ground (not under every joint of a ground slab).
    const standing = new Set();
    for (const e of model.elems) {
      const a = model.nodes[e.n1], b = model.nodes[e.n2];
      if (Math.abs(a.y - b.y) > 1e-6) { standing.add(e.n1); standing.add(e.n2); }
    }
    model.nodes.forEach((n, id) => {
      if (!n.fixed || !standing.has(id)) return;
      const pad = new THREE.Mesh(this.boxGeo, padMat);
      pad.scale.set(0.6, 0.12, 0.6);
      pad.position.set(n.x, 0.06, n.z);
      pad.receiveShadow = true;
      this.footings.add(pad);
    });
    this.deform(null, 0);
  }

  // Place every live part using node positions base + U·scale.
  deform(U, scale, shake = 1, U0 = null) {
    // Exaggeration is tuned to the small elastic movements, so the big movements just before
    // something gives way would be drawn tens of metres long. Soft cap: small offsets are
    // unchanged, large ones level off at DRAW_CAP metres.
    const DRAW_CAP = 1;
    const pos = (id) => {
      const b = this.base[id];
      if (!U) return b;
      const o = U0
        ? [0, 1, 2].map((d) => (U0[id * 3 + d] + (U[id * 3 + d] - U0[id * 3 + d]) * shake) * scale)
        : [U[id * 3] * scale, U[id * 3 + 1] * scale, U[id * 3 + 2] * scale];
      const m = Math.hypot(o[0], o[1], o[2]);
      const k = m > 1e-9 ? (DRAW_CAP * Math.tanh(m / DRAW_CAP)) / m : 1;
      return [b[0] + o[0] * k, b[1] + o[1] * k, b[2] + o[2] * k];
    };
    this.posFn = pos;
    for (const p of this.parts) {
      if (p.fallen) continue;
      for (const pr of p.prims) placePrim(pr.prim, pr.mesh, pos);
    }
  }

  // style(i) -> { color?: hex, opacity?: number, hidden?: bool, damaged?: bool, glow?: hex }
  styleParts(style) {
    this.parts.forEach((p, i) => {
      if (p.fallen) return;
      const s = style(i) || {};
      p.group.visible = !s.hidden;
      for (const pr of p.prims) {
        const m = pr.material;
        const look = pr.prim.look;
        const tintable = look !== 'glass' || s.color === undefined;
        m.color.setHex(s.color !== undefined && tintable && look !== 'glass' ? s.color : m.userData.base);
        const op = s.opacity ?? 1;
        const baseOp = m.userData.opacity;
        m.transparent = op < 1 || look === 'glass' || baseOp < 1;
        m.opacity = Math.min(op, baseOp);
        m.depthWrite = op >= 1;
        m.emissive.setHex(s.glow ?? (s.damaged ? 0x3a0000 : 0x000000));
      }
    });
  }

  // ---- falling debris ------------------------------------------------------------------
  // Parts that fall in the same instant and share joints fall as one rigid body. Bodies are real
  // (if simple) rigid bodies: gravity, an inertia tensor from their joints, and ground contact with
  // friction, so a wall still standing on its footing pivots about its base and topples. A body that
  // hits the ground hard breaks into its panels, which tumble on as rubble.
  // `lean` is the horizontal direction the structure was going when it gave way (wind, quake, or
  // its own sway); without one, the sway of the falling joints decides.
  dropParts(indices, lean = null) {
    const parent = new Map();
    const find = (a) => (parent.get(a) === a ? a : (parent.set(a, find(parent.get(a))), parent.get(a)));
    const byNode = new Map();
    for (const i of indices) {
      parent.set(i, i);
      for (const n of this.parts[i].part.nodes) {
        if (this.model.nodes[n].fixed) continue;
        if (byNode.has(n)) parent.set(find(i), find(byNode.get(n)));
        else byNode.set(n, i);
      }
    }
    const groups = new Map();
    for (const i of indices) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(i);
    }
    for (const list of groups.values()) {
      // Direction to fall: the given lean, else how the falling joints were already moving.
      const sway = new THREE.Vector3();
      for (const i of list) for (const n of this.parts[i].part.nodes) {
        const p = this.posFn(n), q = this.base[n];
        sway.x += p[0] - q[0]; sway.z += p[2] - q[2];
      }
      let d = lean ? new THREE.Vector3(lean[0], 0, lean[1]) : sway;
      if (d.lengthSq() < 1e-10) d = sway;
      if (d.lengthSq() < 1e-10) d.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      d.normalize();
      for (const i of list) {
        const p = this.parts[i];
        p.fallen = true;
        for (const pr of p.prims) {
          // Debris shows its real material, not its last stress colour.
          pr.material.emissive?.setHex(0x000000);
          pr.material.color.setHex(pr.material.userData.base);
          pr.material.opacity = pr.material.userData.opacity;
          pr.material.transparent = pr.prim.look === 'glass' || pr.material.opacity < 1;
          pr.material.depthWrite = true;
        }
        p.group.visible = true;
      }
      // Freeze where the joints were drawn when it gave way: the parts' geometry stays in that shape.
      const at = new Map();
      for (const i of list) for (const n of this.parts[i].part.nodes) if (!at.has(n)) at.set(n, V(this.posFn(n)));
      const c = new THREE.Vector3();
      for (const p of at.values()) c.add(p);
      c.multiplyScalar(1 / at.size);
      // Topple about a horizontal axis so the top heads towards d, plus a little randomness.
      const w = new THREE.Vector3(0, 1, 0).cross(d).multiplyScalar(0.35 + Math.random() * 0.25)
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.15));
      const v = d.clone().multiplyScalar(0.3 + (lean ? Math.min(3, Math.hypot(lean[0], lean[1])) * 0.3 : 0));
      this.addBody(list, at, c, c.clone(), new THREE.Quaternion(), v, w, true);
    }
  }

  // A body holds parts whose geometry is in "rest" coordinates: world = R·(x − c0) + position.
  addBody(list, at, c0, position, quaternion, v, w, canBreak) {
    const body = new THREE.Group();
    body.position.copy(position);
    body.quaternion.copy(quaternion);
    const inner = new THREE.Group();
    inner.position.copy(c0).multiplyScalar(-1);
    body.add(inner);
    for (const i of list) inner.add(this.parts[i].group);
    this.debrisGroup.add(body);
    const pts = [], seen = new Set();
    for (const i of list) for (const n of this.parts[i].part.nodes) {
      if (seen.has(n)) continue;
      seen.add(n);
      pts.push(at.get(n).clone().sub(c0));
    }
    // Inertia of unit point masses at the joints (per unit mass), padded so thin bodies stay finite.
    let r2max = 0;
    const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const p of pts) {
      const r2 = p.lengthSq();
      r2max = Math.max(r2max, r2);
      const a = [p.x, p.y, p.z];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) I[r * 3 + k] += ((r === k ? r2 : 0) - a[r] * a[k]) / pts.length;
    }
    const pad = 0.08 * r2max + 0.02;
    I[0] += pad; I[4] += pad; I[8] += pad;
    const Iinv = new THREE.Matrix3().set(...I).invert();
    this.bodies.push({ body, list, at, c0: c0.clone(), pts, Iinv, v, w, rest: false, still: 0, canBreak });
  }

  stepDebris(dt) {
    if (!this.bodies.length) return;
    const g = 9.81, mu = 0.6, n = Math.max(1, Math.ceil(dt / 0.01)), h = dt / n;
    const R = new THREE.Matrix3(), Iw = new THREE.Matrix3(), Rt = new THREE.Matrix3();
    const q = new THREE.Quaternion(), r = new THREE.Vector3(), vel = new THREE.Vector3(), t = new THREE.Vector3();
    const rxn = new THREE.Vector3(), tmp = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    const broken = [];
    // Effective inverse mass of the body at arm r along direction u (unit mass).
    const kOf = (u) => 1 + tmp.copy(rxn.copy(r).cross(u)).applyMatrix3(Iw).cross(r).dot(u);
    const impulse = (b, u, j) => {
      b.v.addScaledVector(u, j);
      b.w.add(tmp.copy(r).cross(u).multiplyScalar(j).applyMatrix3(Iw));
    };
    for (const b of this.bodies) {
      if (b.rest) continue;
      let hardHit = 0;
      for (let s = 0; s < n; s++) {
        b.v.y -= g * h;
        b.body.position.addScaledVector(b.v, h);
        const wl = b.w.length();
        if (wl > 1e-6) {
          q.setFromAxisAngle(t.copy(b.w).multiplyScalar(1 / wl), wl * h);
          b.body.quaternion.premultiply(q).normalize();
        }
        R.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(b.body.quaternion));
        Rt.copy(R).transpose();
        Iw.copy(R).multiply(b.Iinv).multiply(Rt);
        // Ground contacts: stop the joints going down, with friction along the ground.
        let deepest = 0;
        for (let pass = 0; pass < 2; pass++) for (const p of b.pts) {
          r.copy(p).applyMatrix3(R);
          const y = b.body.position.y + r.y;
          if (y > 0) continue;
          deepest = Math.min(deepest, y);
          vel.copy(b.w).cross(r).add(b.v);
          const vn = vel.y;
          if (vn >= 0) continue;
          hardHit = Math.max(hardHit, -vn);
          const e = vn < -1.5 ? 0.15 : 0;
          const jn = (-(1 + e) * vn) / kOf(Y);
          impulse(b, Y, jn);
          vel.copy(b.w).cross(r).add(b.v);
          t.set(vel.x, 0, vel.z);
          const vt = t.length();
          if (vt > 1e-6) {
            t.multiplyScalar(1 / vt);
            const jt = Math.min(vt / kOf(t), mu * jn);
            impulse(b, t, -jt);
          }
        }
        if (deepest < 0) b.body.position.y -= deepest;
        b.w.multiplyScalar(Math.exp(-0.15 * h));
      }
      if (b.canBreak && hardHit > 2.5) broken.push(b);
      const slow = b.v.length() < 0.08 && b.w.length() < 0.06;
      b.still = slow ? b.still + dt : 0;
      if (b.still > 0.4) b.rest = true;
    }
    for (const b of broken) this.breakBody(b);
  }

  // Split a body into its structural panels (parts sharing the same joints), keeping each piece's
  // current position and velocity, so a house that hits the ground comes apart.
  breakBody(b) {
    const byPanel = new Map();
    for (const i of b.list) {
      const k = [...this.parts[i].part.nodes].sort((x, y) => x - y).join(',');
      if (!byPanel.has(k)) byPanel.set(k, []);
      byPanel.get(k).push(i);
    }
    b.canBreak = false;
    if (byPanel.size < 2) return;
    b.body.removeFromParent();
    this.bodies.splice(this.bodies.indexOf(b), 1);
    for (const list of byPanel.values()) {
      const ns = new Set(list.flatMap((i) => this.parts[i].part.nodes));
      const cs = new THREE.Vector3();
      for (const nd of ns) cs.add(b.at.get(nd));
      cs.multiplyScalar(1 / ns.size);
      const arm = cs.clone().sub(b.c0).applyQuaternion(b.body.quaternion);
      const pos = arm.clone().add(b.body.position);
      const v = b.w.clone().cross(arm).add(b.v).multiplyScalar(0.85);
      const w = b.w.clone().add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.2));
      this.addBody(list, b.at, cs, pos, b.body.quaternion, v, w, false);
    }
  }

  clearDebris() {
    for (const b of this.bodies) b.body.removeFromParent();
    this.bodies = [];
    for (const p of this.parts) {
      if (!p.fallen) continue;
      p.fallen = false;
      this.partsGroup.add(p.group);
    }
  }

  // ---- picking -----------------------------------------------------------------------
  ndc(x, y) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }
  rayToPlane(x, y, h) {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -h);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }
  pickPart(x, y) {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const hits = this.raycaster.intersectObjects(this.partsGroup.children, true);
    for (const h of hits) {
      if (!h.object.visible || !h.object.parent.visible) continue;
      if (h.object.material.opacity < 0.3) continue;
      return h.object.userData.part;
    }
    return null;
  }
  toScreen(p) {
    const v = V(p).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height, v.z];
  }

  // ---- ghosts (placement previews) -----------------------------------------------------
  setGhost(prims, color = 0xa4d5ae, ok = true) {
    for (const mesh of this.ghostGroup.children) {
      if (mesh.geometry !== this.boxGeo && mesh.geometry !== this.cylGeo) mesh.geometry.dispose();
    }
    this.ghostGroup.children[0]?.material.dispose();
    this.ghostGroup.clear();
    if (!prims?.length) return;
    const mat = new THREE.MeshStandardMaterial({ color: ok ? color : 0xd23c3c, transparent: true, opacity: 0.55, depthWrite: false, emissive: ok ? 0x183c28 : 0x440000 });
    for (const prim of prims) {
      let mesh;
      if (prim.t === 'bar') {
        mesh = new THREE.Mesh(prim.round ? this.cylGeo : this.boxGeo, mat);
        mesh.matrixAutoUpdate = false;
      } else {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((prim.t === 'quad' ? 36 : 24) * 3), 3));
        mesh = new THREE.Mesh(g, mat);
      }
      placePrim(prim, mesh, (p) => p);
      this.ghostGroup.add(mesh);
    }
  }

  // ---- loads: point-load arrows, node markers, direction arrows ---------------------------
  showPointLoads(list, posFn) {
    this.loadsGroup.clear();
    for (const pl of list) {
      const dir = new THREE.Vector3(pl.fx, pl.fy, pl.fz);
      const mag = dir.length();
      if (!mag) continue;
      dir.normalize();
      const len = Math.min(4, 0.8 + Math.sqrt(mag) * 0.25);
      const tip = V(posFn ? posFn(pl) : [pl.x, pl.y, pl.z]);
      // A solid arrow (shaft + head) whose tip touches the joint.
      const mat = this.arrowMat ??= new THREE.MeshStandardMaterial({ color: 0xe0332b, emissive: 0x400000 });
      const head = 0.45, r = 0.07 + Math.min(0.12, Math.sqrt(mag) * 0.008);
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len - head, 10), mat);
      shaft.position.y = -(head + (len - head) / 2);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 2.6, head, 14), mat);
      cone.position.y = -head / 2;
      cone.rotation.x = Math.PI;
      g.add(shaft, cone);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      g.position.copy(tip);
      g.traverse((o) => { o.castShadow = true; });
      this.loadsGroup.add(g);
    }
  }
  showNodeMarkers(points) {
    if (!this.nodeMarkers) {
      this.nodeMarkers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshBasicMaterial({ color: 0xe0332b }), 2000);
      this.nodeMarkers.frustumCulled = false;
      this.world.add(this.nodeMarkers);
    }
    const m = new THREE.Matrix4();
    this.nodeMarkers.count = Math.min(points.length, 2000);
    points.slice(0, 2000).forEach((p, i) => { m.makeTranslation(p[0], p[1], p[2]); this.nodeMarkers.setMatrixAt(i, m); });
    this.nodeMarkers.instanceMatrix.needsUpdate = true;
    this.nodeMarkers.visible = points.length > 0;
  }

  // ---- weather ------------------------------------------------------------------------
  makeWeather() {
    const n = 900;
    const mk = (color, size) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.8, depthWrite: false }));
      pts.frustumCulled = false;
      pts.visible = false;
      this.scene.add(pts);
      const p = g.attributes.position.array;
      for (let i = 0; i < n; i++) { p[i * 3] = rand(-30, 30); p[i * 3 + 1] = rand(0, 22); p[i * 3 + 2] = rand(-30, 30); }
      return pts;
    };
    this.windPts = mk(0xffffff, 0.12);
    this.snowPts = mk(0xffffff, 0.18);
    this.weather = { wind: 0, windDir: 0, snow: 0 };
  }
  setWeather(w) {
    this.weather = { ...this.weather, ...w };
    this.windPts.visible = this.weather.wind > 0;
    this.snowPts.visible = this.weather.snow > 0;
  }
  stepWeather(dt) {
    const { wind, windDir, snow } = this.weather;
    const th = (windDir * Math.PI) / 180, dx = Math.cos(th), dz = Math.sin(th);
    if (this.windPts.visible) {
      const p = this.windPts.geometry.attributes.position.array;
      const s = wind * 0.6 * dt;
      for (let i = 0; i < p.length; i += 3) {
        p[i] += dx * s; p[i + 2] += dz * s;
        p[i + 1] += Math.sin((p[i] + p[i + 2]) * 0.3) * s * 0.05;
        if (Math.abs(p[i]) > 30 || Math.abs(p[i + 2]) > 30) {
          p[i] = -dx * 29 + rand(-1, 1) - dz * rand(-30, 30);
          p[i + 2] = -dz * 29 + rand(-1, 1) + dx * rand(-30, 30);
          p[i + 1] = rand(0, 20);
        }
      }
      this.windPts.geometry.attributes.position.needsUpdate = true;
      this.windPts.material.opacity = Math.min(0.85, 0.2 + wind / 60);
    }
    if (this.snowPts.visible) {
      const p = this.snowPts.geometry.attributes.position.array;
      for (let i = 0; i < p.length; i += 3) {
        p[i + 1] -= (1.2 + snow * 0.3) * dt;
        p[i] += dx * wind * 0.2 * dt;
        p[i + 2] += dz * wind * 0.2 * dt;
        if (p[i + 1] < 0 || Math.abs(p[i]) > 30 || Math.abs(p[i + 2]) > 30) { p[i] = rand(-30, 30); p[i + 1] = 22; p[i + 2] = rand(-30, 30); }
      }
      this.snowPts.geometry.attributes.position.needsUpdate = true;
    }
  }
  shakeWorld(offset) { this.world.position.set(offset[0], 0, offset[2]); }
}

const rand = (a, b) => a + Math.random() * (b - a);

// ---- primitive geometry ------------------------------------------------------------------
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

export function placePrim(prim, mesh, pos) {
  if (prim.t === 'bar') {
    let a = pos(prim.a), b = pos(prim.b);
    if (prim.f) {
      // A slice [f0, f1] of the member a→b (one fine-grid piece of a longer member).
      const lerp = (t) => [0, 1, 2].map((d) => a[d] + (b[d] - a[d]) * t);
      [a, b] = [lerp(prim.f[0]), lerp(prim.f[1])];
    }
    _z.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const L = _z.length();
    _z.multiplyScalar(1 / L);
    _y.set(prim.vy[0], prim.vy[1], prim.vy[2]);
    if (Math.abs(_y.dot(_z)) > 0.99) _y.set(1, 0, 0);
    _x.crossVectors(_y, _z).normalize();
    _y.crossVectors(_z, _x);
    _m.makeBasis(_x.multiplyScalar(prim.w), _y.multiplyScalar(prim.h), _z.multiplyScalar(L));
    _m.setPosition((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    mesh.matrix.copy(_m);
    mesh.matrixWorldNeedsUpdate = true;
    return;
  }
  const arr = mesh.geometry.attributes.position.array;
  if (prim.t === 'quad') {
    const [c0, c1, c2, c3] = prim.c.map((id) => pos(id));
    const [u0, u1, v0, v1] = prim.uv;
    const bil = (u, v) => [0, 1, 2].map((d) => (1 - u) * (1 - v) * c0[d] + u * (1 - v) * c1[d] + u * v * c2[d] + (1 - u) * v * c3[d]);
    let q = [bil(u0, v0), bil(u1, v0), bil(u1, v1), bil(u0, v1)];
    let n = cross3(sub3(c1, c0), sub3(c3, c0));
    n = norm3(n);
    const flip = (prim.horizontal && n[1] < 0) || (prim.normalHint && dot3(n, prim.normalHint) < 0);
    // Flipping the normal must flip the winding too, or the slab is drawn inside out (from above
    // you'd see its inner walls as a grid of dark lines).
    if (flip) { n = n.map((v) => -v); q = [q[0], q[3], q[2], q[1]]; }
    const off = prim.offset || 0, t = prim.thick / 2;
    const top = q.map((p) => add3(p, n, off + t));
    const bot = q.map((p) => add3(p, n, off - t));
    writeQuadSlab(arr, top, bot);
  } else if (prim.t === 'tri') {
    let c = prim.c.map((id) => pos(id));
    let n = norm3(cross3(sub3(c[1], c[0]), sub3(c[2], c[0])));
    if (prim.normalHint && dot3(n, prim.normalHint) < 0) { n = n.map((v) => -v); c = [c[0], c[2], c[1]]; }
    const t = prim.thick / 2, off = prim.offset || 0;
    const top = c.map((p) => add3(p, n, off + t)), bot = c.map((p) => add3(p, n, off - t));
    let k = 0;
    const tri = (a, b, d) => { for (const p of [a, b, d]) { arr[k++] = p[0]; arr[k++] = p[1]; arr[k++] = p[2]; } };
    tri(top[0], top[1], top[2]); tri(bot[0], bot[2], bot[1]);
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      tri(bot[i], bot[j], top[j]); tri(bot[i], top[j], top[i]);
    }
  }
  mesh.geometry.attributes.position.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  if (!mesh.geometry.attributes.uv) {
    const uv = new Float32Array(arr.length / 3 * 2);
    const normals = mesh.geometry.attributes.normal.array;
    for (let i = 0; i < arr.length / 3; i++) {
      const n = i * 3;
      const ax = Math.abs(normals[n]), ay = Math.abs(normals[n + 1]), az = Math.abs(normals[n + 2]);
      uv[i * 2] = ax > az && ax > ay ? arr[n + 2] : arr[n];
      uv[i * 2 + 1] = ay > ax && ay > az ? arr[n + 2] : arr[n + 1];
    }
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  mesh.geometry.computeBoundingSphere();
  mesh.geometry.computeBoundingBox();
}

function writeQuadSlab(arr, T, B) {
  let k = 0;
  const tri = (a, b, d) => { for (const p of [a, b, d]) { arr[k++] = p[0]; arr[k++] = p[1]; arr[k++] = p[2]; } };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  quad(T[0], T[1], T[2], T[3]);
  quad(B[0], B[3], B[2], B[1]);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(B[i], B[j], T[j], T[i]);
  }
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (p, n, s) => [p[0] + n[0] * s, p[1] + n[1] * s, p[2] + n[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
