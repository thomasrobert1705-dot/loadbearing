// Procedural scenery and surface textures: all assets stay local and lightweight.
import * as THREE from './vendor/three.module.js';

export function surfaceTexture(kind, renderer) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e0dbd0'; ctx.fillRect(0, 0, 256, 256);
  // Deterministic variation keeps rebuilt surfaces visually stable.
  let seed = 71;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  if (kind === 'brick' || kind === 'tile' || kind === 'stone') {
    const height = kind === 'tile' ? 64 : kind === 'stone' ? 64 : 32, width = kind === 'tile' ? 64 : kind === 'stone' ? 96 : 128;
    for (let row = 0; row < 256 / height; row++) {
      for (let col = -1; col < 256 / width + 1; col++) {
        const light = 68 + random() * 22;
        ctx.fillStyle = `hsl(28 12% ${light}%)`;
        ctx.fillRect(col * width + (row % 2) * width / 2 + 2, row * height + 2, width - 4, height - 4);
        ctx.fillStyle = '#ffffff20'; ctx.fillRect(col * width + (row % 2) * width / 2 + 2, row * height + 2, width - 4, 2);
      }
    }
  } else if (kind === 'wood' || kind === 'metal') {
    for (let x = 0; x < 256; x++) {
      ctx.fillStyle = `rgba(60,45,25,${random() * .17})`;
      ctx.fillRect(x, 0, 1, 256);
    }
    for (let x = 0; x < 256; x += 64) {
      ctx.fillStyle = '#514b423a'; ctx.fillRect(x, 0, 2, 256);
    }
  } else if (kind === 'earth') {
    for (let y = 0; y < 256; y += 16) {
      ctx.fillStyle = `rgba(80,65,40,${random() * .12})`; ctx.fillRect(0, y, 256, 16);
    }
  }
  for (let i = 0; i < 12000; i++) {
    const v = random() > .5 ? 255 : 35;
    ctx.fillStyle = `rgba(${v},${v},${v},${random() * .09})`;
    ctx.fillRect(random() * 256, random() * 256, 1, 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

export function addScenery(world, size) {
  const stone = new THREE.MeshStandardMaterial({ color: 0xc3c4ad, roughness: .95 });
  const bark = new THREE.MeshStandardMaterial({ color: 0x70634c, roughness: 1 });
  const leaves = [0x64815d, 0x849865, 0x94a675].map(color => new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true }));
  const box = new THREE.BoxGeometry(1, 1, 1);
  const crown = new THREE.IcosahedronGeometry(1, 1);
  const trunk = new THREE.CylinderGeometry(.12, .19, 2, 7);
  const mesh = (geo, mat, x, y, z, sx = 1, sy = 1, sz = 1) => {
    const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.scale.set(sx, sy, sz);
    o.castShadow = o.receiveShadow = true; world.add(o); return o;
  };
  // A slim concrete edge defines the buildable site without hiding the grid.
  const half = size / 2 + .3;
  for (const sign of [-1, 1]) {
    mesh(box, stone, sign * half, .06, 0, .12, .12, size + .7);
    mesh(box, stone, 0, .06, sign * half, size + .7, .12, .12);
  }
  // Planting lives outside the editable plot and never participates in picking or physics.
  const positions = [[-15,-10,1.2],[-16,-3,.9],[-15,7,1.1],[-10,-16,1],[-3,-17,1.3],[8,-16,1.1],[15,-10,1],[17,3,.8],[15,12,1.1],[-16,15,.8]];
  positions.forEach(([x,z,s], i) => {
    mesh(trunk, bark, x, s, z, s, s, s);
    const tree = mesh(crown, leaves[i % 3], x, 3 * s, z, 1.5 * s, 2 * s, 1.5 * s);
    tree.rotation.y = i * 1.7;
    mesh(crown, leaves[(i + 1) % 3], x + .8 * s, 2.6 * s, z + .4, s, 1.3 * s, s);
    mesh(crown, leaves[i % 3], x - .7, .3, z + 1.5, .7, .5, .7);
  });
  // A few stepping stones give the scene a human scale.
  for (let i = 0; i < 6; i++) mesh(box, stone, 1.5, .025, half + 1.2 + i * 1.4, 1.8, .06, 1);
}
