import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../public/vendor/three.module.js';
import { placePrim, Scene3D } from '../public/render.js';
import { buildModel } from '../public/engine/model.js';
import { PRESETS } from '../public/engine/presets.js';

test('all preset surfaces have finite texture coordinates that stay attached during deformation', () => {
  for (const preset of PRESETS) {
    const model = buildModel(preset.design());
    const pos = id => { const n = model.nodes[id]; return [n.x, n.y, n.z]; };
    for (const part of model.parts) for (const prim of part.prims) {
      if (prim.t === 'bar') continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((prim.t === 'quad' ? 36 : 24) * 3), 3));
      const mesh = new THREE.Mesh(geometry);
      placePrim(prim, mesh, pos);
      const original = geometry.attributes.uv.array.slice();
      assert.ok(original.every(Number.isFinite), preset.id);
      assert.equal(original.length, geometry.attributes.position.count * 2);
      assert.ok(original.some(v => v !== original[0]), 'surface must have texture area');
      placePrim(prim, mesh, id => pos(id).map((v, axis) => v + (axis === 0 ? .1 * pos(id)[1] : 0)));
      assert.deepEqual(geometry.attributes.uv.array, original, 'UVs must not slide as the building bends');
      assert.ok(geometry.attributes.position.array.every(Number.isFinite));
      geometry.dispose(); mesh.material.dispose();
    }
  }
});

test('camera views frame empty plots and tall structures at desktop and mobile aspects', () => {
  for (const aspect of [.55, 1.6]) for (const empty of [true, false]) {
    const partsGroup = new THREE.Group();
    if (!empty) partsGroup.add(new THREE.Mesh(new THREE.BoxGeometry(12, 24, 8)));
    const camera = new THREE.PerspectiveCamera(40, aspect, .1, 500);
    const controls = { target: new THREE.Vector3(), update() {} };
    const scene = { partsGroup, camera, controls };
    for (const view of ['perspective', 'top', 'front']) {
      Scene3D.prototype.setView.call(scene, view);
      assert.ok(camera.position.toArray().every(Number.isFinite));
      const distance = camera.position.distanceTo(controls.target);
      assert.ok(distance >= 18);
      if (!empty) assert.ok(distance * Math.tan(40 * Math.PI / 360) * Math.min(1, aspect) >= 12);
      if (view === 'top') assert.ok(camera.position.y > 0 && Math.abs(camera.position.x) < .001);
      if (view === 'front') assert.ok(camera.position.z > 0 && Math.abs(camera.position.x) < .001);
    }
  }
});
