import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const CAR_MODEL_URL = './rb6.glb';
const gltfLoader = new GLTFLoader();
let cachedGltfScene = null;

function hexToThree(hex) {
  return new THREE.Color(hex);
}

function emptyPartMats() {
  return {
    chassis: [], frontWing: [], frontWingShadow: [],
    rearWing: [], rearWingShadow: [], nose: [], accents: [], wheels: [],
  };
}

function paintMat(hex, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: hex,
    metalness: opts.metalness ?? 0.62,
    roughness: opts.roughness ?? 0.28,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
}

function stashStockMaterial(mat) {
  if (!mat || mat.userData.stockCaptured) return;
  mat.userData.stockCaptured = true;
  mat.userData.stockMap = mat.map || null;
  mat.userData.stockColor = mat.color ? mat.color.clone() : new THREE.Color(0xffffff);
  mat.userData.stockEmissive = mat.emissive ? mat.emissive.clone() : null;
}

function glbMatName(mat) {
  return ((mat && mat.name) || '').toLowerCase();
}

// RB6 GLB: +Y is nose/front, -Y is tail, -Z is up, +X is right. Body21 is one
// livery shader covering chassis + wings + nose — split by triangle centroid.
function classifyBodyPaintPoint(x, y, z, box) {
  const ySpan = Math.max(box.max.y - box.min.y, 1e-6);
  const zSpan = Math.max(box.max.z - box.min.z, 1e-6);
  const yN = (y - box.min.y) / ySpan;
  const zN = (z - box.min.z) / zSpan;
  const ax = Math.abs(x);
  if (yN > 0.78 && zN > 0.48) return 'frontWing';
  if (yN > 0.72 && ax < 1.85 && zN < 0.75) return 'nose';
  if (yN < 0.22 && zN < 0.38) return 'rearWing';
  return 'chassis';
}

function cloneLiveryMaterial(srcMat) {
  const mat = srcMat.clone();
  mat.userData = {};
  stashStockMaterial(mat);
  return mat;
}

function splitBodyPaintMesh(mesh, mats) {
  const src = mesh.geometry;
  if (!src || !src.getAttribute('position')) {
    mats.chassis.push(mesh.material);
    return;
  }
  src.computeBoundingBox();
  const box = src.boundingBox;
  const pos = src.getAttribute('position');
  const idx = src.index;
  const buckets = { chassis: [], frontWing: [], nose: [], rearWing: [] };
  const pushTri = (a, b, c) => {
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    buckets[classifyBodyPaintPoint(cx, cy, cz, box)].push(a, b, c);
  };
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      pushTri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      pushTri(i, i + 1, i + 2);
    }
  }

  const parent = mesh.parent;
  if (!parent) {
    mats.chassis.push(mesh.material);
    return;
  }
  const group = new THREE.Group();
  group.name = (mesh.name || 'body') + '_paintParts';
  group.position.copy(mesh.position);
  group.quaternion.copy(mesh.quaternion);
  group.scale.copy(mesh.scale);

  ['chassis', 'frontWing', 'nose', 'rearWing'].forEach((part) => {
    const indices = buckets[part];
    if (!indices.length) return;
    const geo = new THREE.BufferGeometry();
    // Clone attributes so part geos do not share GPU buffers with each other / source.
    for (const name of Object.keys(src.attributes)) {
      geo.setAttribute(name, src.getAttribute(name).clone());
    }
    if (src.morphAttributes) {
      geo.morphAttributes = {};
      for (const name of Object.keys(src.morphAttributes)) {
        geo.morphAttributes[name] = src.morphAttributes[name].map((attr) => attr.clone());
      }
    }
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    const partMesh = new THREE.Mesh(geo, cloneLiveryMaterial(mesh.material));
    partMesh.castShadow = true;
    partMesh.receiveShadow = true;
    partMesh.name = part;
    group.add(partMesh);
    mats[part].push(partMesh.material);
  });

  parent.add(group);
  parent.remove(mesh);
  // Original body mesh is replaced — free its geometry (materials may still be referenced).
  if (mesh.geometry) {
    try { mesh.geometry.dispose(); } catch (e) { /* ok */ }
  }
}

// Footprints from Kart.draw (2D race car). Mapping: 2D x→+Z, 2D y→+X, height→+Y.
const CAR2D_SCALE = 1 / 12;
const CAR2D = {
  rearWing: [[-21, -9], [-16, -9], [-16, 9], [-21, 9]],
  rearWingBarMain: [[-21, -9], [-19, -9], [-19, 9], [-21, 9]],
  rearWingBarTipA: [[-17, -9], [-15, -9], [-15, -4], [-17, -4]],
  rearWingBarTipB: [[-17, 4], [-15, 4], [-15, 9], [-17, 9]],
  diffuser: [[-14, -5], [-20, -7], [-20, 7], [-14, 5]],
  sidepodL: [[-11, -8], [4, -8], [6, -5], [-11, -5]],
  sidepodR: [[-11, 8], [4, 8], [6, 5], [-11, 5]],
  monocoque: [[-12, -4], [8, -3], [13, -1.5], [13, 1.5], [8, 3], [-12, 4]],
  nose: [[12, -1.8], [19, -0.6], [19, 0.6], [12, 1.8]],
  frontWing: [[16, -12], [21, -12], [21, 12], [16, 12]],
  frontWingTipA: [[16, -12], [21, -12], [21, -8], [16, -8]],
  frontWingTipB: [[16, 8], [21, 8], [21, 12], [16, 12]],
  cockpit: { cx: 1, cy: 0, rx: 4, ry: 2.5 },
  halo: { p0: [-2, -2.5], p1: [2, -6.5], p2: [6, -2.5] },
  tcam: [[0, -6], [2, -6], [2, -3], [0, -3]],
  wheels: [[10, -10], [10, 10], [-8, -10], [-8, 10]],
  wheelR: 4.5,
  rimR: 2.6,
};

function shapeFromPoints(pts2d) {
  const shape = new THREE.Shape();
  pts2d.forEach(([x, y], i) => {
    // Shape XY → after Rx(-90): world (y*S, h, x*S). Use (y, -x) so +Z = nose.
    const sx = y * CAR2D_SCALE;
    const sy = -x * CAR2D_SCALE;
    if (i === 0) shape.moveTo(sx, sy);
    else shape.lineTo(sx, sy);
  });
  shape.closePath();
  return shape;
}

/** Shrink a 2D footprint toward its centroid (units = Kart.draw coords). */
function insetPoints(pts2d, amount) {
  let cx = 0, cy = 0;
  pts2d.forEach(([x, y]) => { cx += x; cy += y; });
  cx /= pts2d.length;
  cy /= pts2d.length;
  return pts2d.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const t = Math.max(0, 1 - amount / len);
    return [cx + dx * t, cy + dy * t];
  });
}

/** Round polygon corners with quadratic arcs (Kart.draw units). */
function filletPolygon(pts2d, radius, segments = 5) {
  if (!pts2d || pts2d.length < 3 || radius <= 0) return pts2d;
  const n = pts2d.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = pts2d[(i - 1 + n) % n];
    const curr = pts2d[i];
    const next = pts2d[(i + 1) % n];
    const v1x = prev[0] - curr[0];
    const v1y = prev[1] - curr[1];
    const v2x = next[0] - curr[0];
    const v2y = next[1] - curr[1];
    const len1 = Math.hypot(v1x, v1y) || 1;
    const len2 = Math.hypot(v2x, v2y) || 1;
    const r = Math.min(radius, len1 * 0.42, len2 * 0.42);
    if (r < 0.08) {
      out.push(curr);
      continue;
    }
    const p1 = [curr[0] + (v1x / len1) * r, curr[1] + (v1y / len1) * r];
    const p2 = [curr[0] + (v2x / len2) * r, curr[1] + (v2y / len2) * r];
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const mt = 1 - t;
      out.push([
        mt * mt * p1[0] + 2 * mt * t * curr[0] + t * t * p2[0],
        mt * mt * p1[1] + 2 * mt * t * curr[1] + t * t * p2[1],
      ]);
    }
  }
  return out;
}

function extrudePart(pts2d, height, mat, yBottom, bevel = true, bevelAmt = null, cornerR = 1.6) {
  const soft = bevelAmt != null ? bevelAmt : (bevel ? Math.min(0.075, height * 0.45) : 0);
  const rounded = (bevel && cornerR > 0) ? filletPolygon(pts2d, cornerR, 8) : pts2d;
  const geo = new THREE.ExtrudeGeometry(shapeFromPoints(rounded), {
    depth: height,
    bevelEnabled: bevel && soft > 0,
    bevelThickness: soft,
    bevelSize: soft * 0.95,
    bevelSegments: bevel ? 6 : 0,
    curveSegments: 16,
  });
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = yBottom;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Lower wide slab + inset rounded cap for body volume. */
function stackBody(pts2d, mat, y0, hBase, hCap, inset = 0.55, cornerR = 1.8) {
  const base = extrudePart(pts2d, hBase, mat, y0, true, Math.min(0.07, hBase * 0.5), cornerR);
  const mid = extrudePart(insetPoints(pts2d, inset * 0.55), hCap * 0.55, mat, y0 + hBase * 0.55, true, 0.06, cornerR * 0.9);
  const cap = extrudePart(insetPoints(pts2d, inset), hCap * 0.65, mat, y0 + hBase * 0.85, true, 0.07, cornerR * 0.75);
  return [base, mid, cap];
}

function ellipsePoints(cx, cy, rx, ry, segments = 32) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

function sampleQuadBezier(p0, p1, p2, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
    const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
    pts.push([x, y, t]);
  }
  return pts;
}

function makeNumberTexture(text) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 90px Orbitron, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(text), 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Stage-owned: safe to dispose when the car stage tears down.
  tex.userData.ownedByStage = true;
  return tex;
}

/** Dispose GPU resources for a scene graph without touching shared GLTF cache textures. */
function createDisposeTracker() {
  return { geometries: new Set(), materials: new Set(), textures: new Set() };
}

function disposeTextureSafe(tex, tracker) {
  if (!tex || !tex.isTexture) return;
  if (tracker.textures.has(tex.uuid)) return;
  // Only dispose textures this stage created (e.g. canvas number, PMREM env).
  // Cloned GLB materials share map refs with cachedGltfScene — never free those.
  if (!tex.userData || !tex.userData.ownedByStage) return;
  tracker.textures.add(tex.uuid);
  try { tex.dispose(); } catch (e) { /* already gone */ }
}

function disposeMaterialSafe(mat, tracker) {
  if (!mat) return;
  if (tracker.materials.has(mat.uuid)) return;
  tracker.materials.add(mat.uuid);
  const mapKeys = [
    'map', 'lightMap', 'bumpMap', 'normalMap', 'specularMap', 'envMap',
    'alphaMap', 'aoMap', 'displacementMap', 'emissiveMap', 'metalnessMap',
    'roughnessMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
  ];
  for (let i = 0; i < mapKeys.length; i++) {
    disposeTextureSafe(mat[mapKeys[i]], tracker);
  }
  try { mat.dispose(); } catch (e) { /* already gone */ }
}

function disposeGeometrySafe(geo, tracker) {
  if (!geo) return;
  if (tracker.geometries.has(geo.uuid)) return;
  tracker.geometries.add(geo.uuid);
  try { geo.dispose(); } catch (e) { /* already gone */ }
}

function disposeObjectTree(root, tracker) {
  if (!root) return tracker || createDisposeTracker();
  const t = tracker || createDisposeTracker();
  root.traverse((obj) => {
    if (obj.geometry) disposeGeometrySafe(obj.geometry, t);
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (let i = 0; i < mats.length; i++) disposeMaterialSafe(mats[i], t);
    }
  });
  return t;
}

function clearGroupChildren(group, tracker) {
  if (!group) return;
  const t = tracker || createDisposeTracker();
  while (group.children.length) {
    const child = group.children[0];
    group.remove(child);
    disposeObjectTree(child, t);
  }
  return t;
}

/** Sculpted extrusion of Kart.draw footprints for the cover/garage car. */
function buildProceduralCar() {
  const group = new THREE.Group();
  const partMats = {
    chassis: [],
    frontWing: [],
    frontWingShadow: [],
    rearWing: [],
    rearWingShadow: [],
    nose: [],
    accents: [],
    wheels: [],
  };

  const matChassis = paintMat(0x00ccff, { metalness: 0.58, roughness: 0.28, clearcoat: 0.75 });
  const matFront = paintMat(0xe8e8e8, { metalness: 0.45, roughness: 0.34, clearcoat: 0.55 });
  const matFrontShadow = paintMat(0x606060, { metalness: 0.4, roughness: 0.4, clearcoat: 0.35 });
  const matRear = paintMat(0x00ccff, { metalness: 0.58, roughness: 0.28, clearcoat: 0.7 });
  const matRearShadow = paintMat(0x005f8f, { metalness: 0.45, roughness: 0.36, clearcoat: 0.4 });
  const matNose = paintMat(0x00ccff, { metalness: 0.6, roughness: 0.26, clearcoat: 0.8 });
  const matAccent = paintMat(0xffd700, { metalness: 0.72, roughness: 0.22, emissive: 0x442200, physical: false });
  const matWheel = paintMat(0x141414, { metalness: 0.05, roughness: 0.94, physical: false });
  const matRim = paintMat(0x3c3c3c, { metalness: 0.7, roughness: 0.35, clearcoat: 0.4 });
  const matSpoke = paintMat(0x555555, { metalness: 0.55, roughness: 0.42, physical: false });
  const matCockpit = paintMat(0x0c1b2a, { metalness: 0.12, roughness: 0.9, physical: false });
  const matTcam = paintMat(0xffd700, { metalness: 0.78, roughness: 0.2, physical: false });

  partMats.chassis.push(matChassis);
  partMats.frontWing.push(matFront);
  partMats.frontWingShadow.push(matFrontShadow);
  partMats.rearWing.push(matRear);
  partMats.rearWingShadow.push(matRearShadow);
  partMats.nose.push(matNose);
  partMats.accents.push(matAccent, matTcam);
  partMats.wheels.push(matWheel, matRim, matSpoke);

  const add = (mesh) => {
    group.add(mesh);
    return mesh;
  };
  const addAll = (meshes) => meshes.forEach(add);

  // Rear wing — thin aero plate + taller endplates
  add(extrudePart(CAR2D.rearWing, 0.055, matRear, 0.42, true, 0.02, 0.7));
  add(extrudePart(CAR2D.rearWingBarMain, 0.38, matRearShadow, 0.18, true, 0.028, 0.55));
  add(extrudePart(CAR2D.rearWingBarTipA, 0.34, matRearShadow, 0.20, true, 0.022, 0.45));
  add(extrudePart(CAR2D.rearWingBarTipB, 0.34, matRearShadow, 0.20, true, 0.022, 0.45));

  // Diffuser — low beveled wedge
  add(extrudePart(CAR2D.diffuser, 0.055, matAccent, 0.015, true, 0.032, 0.85));

  // Sidepods + monocoque — stacked rounded volumes
  addAll(stackBody(CAR2D.sidepodL, matChassis, 0.05, 0.11, 0.10, 0.5, 1.15));
  addAll(stackBody(CAR2D.sidepodR, matChassis, 0.05, 0.11, 0.10, 0.5, 1.15));
  addAll(stackBody(CAR2D.monocoque, matChassis, 0.07, 0.15, 0.14, 0.55, 1.25));
  // Extra top spine for softer crown
  add(extrudePart(insetPoints(CAR2D.monocoque, 1.0), 0.07, matChassis, 0.28, true, 0.045, 1.0));

  // Nose — base + raised tip cap
  add(extrudePart(CAR2D.nose, 0.10, matNose, 0.055, true, 0.04, 0.7));
  add(extrudePart(insetPoints(CAR2D.nose, 0.4), 0.09, matNose, 0.125, true, 0.048, 0.6));

  const cockpitY = 0.32;
  add(extrudePart(
    ellipsePoints(CAR2D.cockpit.cx, CAR2D.cockpit.cy, CAR2D.cockpit.rx, CAR2D.cockpit.ry, 36),
    0.045, matCockpit, cockpitY, true, 0.025, 0
  ));

  // Halo tube — smoother, slightly thicker
  const haloSamples = sampleQuadBezier(CAR2D.halo.p0, CAR2D.halo.p1, CAR2D.halo.p2, 28);
  const haloPts = haloSamples.map(([x, y, t]) => new THREE.Vector3(
    y * CAR2D_SCALE,
    0.38 + Math.sin(t * Math.PI) * 0.18,
    x * CAR2D_SCALE
  ));
  const haloCurve = new THREE.CatmullRomCurve3(haloPts);
  const haloMesh = new THREE.Mesh(
    new THREE.TubeGeometry(haloCurve, 48, 0.042, 12, false),
    matAccent
  );
  haloMesh.castShadow = true;
  haloMesh.receiveShadow = true;
  add(haloMesh);

  // T-cam — rounded nub on halo apex
  const apex = haloPts[Math.floor(haloPts.length / 2)];
  const tcam = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), matTcam);
  tcam.position.copy(apex);
  tcam.position.y += 0.04;
  tcam.castShadow = true;
  add(tcam);
  const tcamStem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.022, 0.06, 10),
    matTcam
  );
  tcamStem.position.set(apex.x, apex.y - 0.01, apex.z);
  tcamStem.castShadow = true;
  add(tcamStem);

  // Front wing — thin plate raised off ground + endplates
  add(extrudePart(CAR2D.frontWing, 0.038, matFront, 0.055, true, 0.016, 0.65));
  add(extrudePart(CAR2D.frontWingTipA, 0.12, matFrontShadow, 0.02, true, 0.02, 0.5));
  add(extrudePart(CAR2D.frontWingTipB, 0.12, matFrontShadow, 0.02, true, 0.02, 0.5));

  // Wheels — rounded tyre + inset rim + thin spokes
  const tyreR = CAR2D.wheelR * CAR2D_SCALE;
  const rimR = CAR2D.rimR * CAR2D_SCALE;
  const tyreW = 0.13;
  const tyreGeo = new THREE.TorusGeometry(tyreR * 0.72, tyreR * 0.28, 14, 36);
  const rimGeo = new THREE.CylinderGeometry(rimR, rimR, tyreW * 0.5, 28);
  const hubGeo = new THREE.CylinderGeometry(rimR * 0.28, rimR * 0.28, tyreW * 0.58, 16);
  CAR2D.wheels.forEach(([wx, wy]) => {
    const x = wy * CAR2D_SCALE;
    const z = wx * CAR2D_SCALE;
    const y = tyreR;
    const tyre = new THREE.Mesh(tyreGeo, matWheel);
    tyre.rotation.y = Math.PI / 2;
    tyre.position.set(x, y, z);
    tyre.castShadow = true;
    tyre.receiveShadow = true;
    add(tyre);
    const rim = new THREE.Mesh(rimGeo, matRim);
    rim.rotation.z = Math.PI / 2;
    rim.position.set(x, y, z);
    rim.castShadow = true;
    add(rim);
    const hub = new THREE.Mesh(hubGeo, matSpoke);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(x, y, z);
    add(hub);
    const spokeRoot = new THREE.Group();
    spokeRoot.position.set(x, y, z);
    for (let s = 0; s < 5; s++) {
      const spoke = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.01, rimR * 1.75, 6),
        matSpoke
      );
      const pivot = new THREE.Group();
      pivot.rotation.x = (s * Math.PI * 2) / 5;
      spoke.position.y = rimR * 0.42;
      pivot.add(spoke);
      spokeRoot.add(pivot);
    }
    add(spokeRoot);
  });

  // Cockpit number (P1 preview)
  const numTex = makeNumberTexture('1');
  const numMat = new THREE.MeshBasicMaterial({
    map: numTex,
    transparent: true,
    depthWrite: false,
  });
  const num = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), numMat);
  num.rotation.x = -Math.PI / 2;
  num.position.set(
    CAR2D.cockpit.cy * CAR2D_SCALE,
    cockpitY + 0.05,
    CAR2D.cockpit.cx * CAR2D_SCALE
  );
  add(num);

  return { group, partMats };
}

function createCarStage(canvas, opts = {}) {
  const statusEl = opts.statusEl || null;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  // Keep the RenderTarget so we can dispose the env map without touching shared assets.
  const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
  if (envTarget && envTarget.texture) {
    envTarget.texture.userData.ownedByStage = true;
    scene.environment = envTarget.texture;
  }
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);
  camera.position.set(2.85, 1.15, 3.85);

  const hemi = new THREE.HemisphereLight(0xb8e6ff, 0x1a1520, 1.15);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.85);
  key.position.set(4.2, 7.5, 3.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 24;
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -4;
  key.shadow.bias = -0.0008;
  key.shadow.radius = 2.5;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88c8ff, 0.48);
  fill.position.set(-3.2, 2.8, -2.2);
  scene.add(fill);
  const rimLight = new THREE.DirectionalLight(0xffe0b0, 0.35);
  rimLight.position.set(-1.5, 2.5, 4);
  scene.add(rimLight);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2.4, 48),
    new THREE.MeshStandardMaterial({ color:0x0b1524, metalness:0.25, roughness:0.78, transparent:true, opacity:0.94 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.55, 1.72, 48),
    new THREE.MeshBasicMaterial({ color:0x00f5ff, transparent:true, opacity:0.28, side:THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  const root = new THREE.Group();
  scene.add(root);

  let car = null;
  let partMats = {
    chassis: [], frontWing: [], frontWingShadow: [],
    rearWing: [], rearWingShadow: [], nose: [], accents: [], wheels: [],
  };
  let animId = 0;
  let running = false;
  let disposed = false;
  let yaw = 0.55;
  let autoSpin = true;
  let drag = false;
  let lastX = 0;
  let bounceT = 0;
  let autoSpinTimer = 0;

  function setStatus(msg) {
    if(statusEl) statusEl.textContent = msg;
  }

  function resize() {
    if (disposed) return;
    const parent = canvas.parentElement || canvas;
    const w = Math.max(1, parent.clientWidth || canvas.clientWidth);
    const h = Math.max(1, parent.clientHeight || canvas.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function fitCarOnPad(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const scale = 2.55 / Math.max(size.x, size.y, size.z, 0.001);
    obj.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(obj);
    const center2 = box2.getCenter(new THREE.Vector3());
    const minY = box2.min.y;
    obj.position.x -= center2.x;
    obj.position.z -= center2.z;
    obj.position.y -= minY;
  }

  function mapGlbMaterials(rootObj) {
    const mats = emptyPartMats();
    const bodyMeshes = [];
    rootObj.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      list.forEach((mat) => {
        if (!mat) return;
        stashStockMaterial(mat);
        const name = glbMatName(mat);
        if (name.startsWith('window')) return;
        if (name.startsWith('meshpart')) {
          mats.wheels.push(mat);
          return;
        }
        if (name.startsWith('chassis1')) {
          mats.accents.push(mat);
          return;
        }
        if (name.startsWith('body21')) {
          if (!bodyMeshes.includes(o)) bodyMeshes.push(o);
          return;
        }
        mats.chassis.push(mat);
      });
    });
    bodyMeshes.forEach((mesh) => splitBodyPaintMesh(mesh, mats));
    return mats;
  }

  function applyMatPaint(mat, paintId, part) {
    if (!mat) return;
    const isStock = paintId === 'stock';
    const pc = (typeof window.getPaintColor === 'function')
      ? window.getPaintColor(paintId)
      : { body: '#00ccff', shadow: '#005f8f' };
    const hasStock = !!(mat.userData && mat.userData.stockCaptured);

    if (hasStock && isStock) {
      mat.map = mat.userData.stockMap || null;
      if (mat.userData.stockColor) mat.color.copy(mat.userData.stockColor);
      else mat.color.set(0xffffff);
      if (mat.emissive && mat.userData.stockEmissive) {
        mat.emissive.copy(mat.userData.stockEmissive);
      } else if (mat.emissive) {
        mat.emissive.set(0x000000);
      }
    } else if (hasStock && !isStock) {
      mat.map = null;
      mat.color.copy(hexToThree(pc.body));
      if (part === 'accents' && mat.emissive) {
        mat.emissive.copy(hexToThree(pc.body)).multiplyScalar(0.18);
      } else if (mat.emissive) {
        mat.emissive.set(0x000000);
      }
    } else {
      mat.color.copy(hexToThree(pc.body));
      if (part === 'accents' && mat.emissive) {
        mat.emissive.copy(hexToThree(pc.body)).multiplyScalar(0.18);
      } else if (mat.emissive) {
        mat.emissive.set(0x000000);
      }
    }
    mat.needsUpdate = true;
  }

  function applyLivery(livery) {
    if (!livery) return;
    (partMats.chassis || []).forEach((mat) => applyMatPaint(mat, livery.chassis, 'chassis'));
    (partMats.accents || []).forEach((mat) => applyMatPaint(mat, livery.accents, 'accents'));
    ['frontWing', 'rearWing', 'nose'].forEach((part) => {
      const id = livery[part];
      (partMats[part] || []).forEach((mat) => applyMatPaint(mat, id, part));
      const pc = (typeof window.getPaintColor === 'function')
        ? window.getPaintColor(id)
        : { body: '#00ccff', shadow: '#005f8f' };
      (partMats[part + 'Shadow'] || []).forEach((mat) => {
        if (!mat) return;
        mat.color.copy(hexToThree(pc.shadow || pc.body));
        mat.needsUpdate = true;
      });
    });
  }

  function placeCar(builtGroup, builtMats, extraRotY = Math.PI * 0.12) {
    clearGroupChildren(root);
    car = builtGroup;
    partMats = builtMats;
    fitCarOnPad(car);
    car.rotation.y += extraRotY;
    root.add(car);
  }

  async function prepareCar() {
    try {
      if (!cachedGltfScene) {
        const gltf = await gltfLoader.loadAsync(CAR_MODEL_URL);
        if (disposed) return 'aborted';
        cachedGltfScene = gltf.scene;
      }
      if (disposed) return 'aborted';
      // Deep-clone materials AND geometries so dispose never frees the shared GLTF cache.
      // (Object3D.clone shares BufferGeometry by default.)
      const model = cachedGltfScene.clone(true);
      model.traverse((o) => {
        if (!o.isMesh) return;
        if (o.geometry) o.geometry = o.geometry.clone();
        if (Array.isArray(o.material)) o.material = o.material.map((m) => m.clone());
        else if (o.material) o.material = o.material.clone();
      });
      if (disposed) {
        disposeObjectTree(model);
        return 'aborted';
      }
      model.rotation.set(0, Math.PI * 0.15, 0);
      const mats = mapGlbMaterials(model);
      if (disposed) {
        disposeObjectTree(model);
        return 'aborted';
      }
      placeCar(model, mats, 0);
      return 'glb';
    } catch (err) {
      if (disposed) return 'aborted';
      console.warn('RB6 GLB load failed, using procedural car', err);
      const built = buildProceduralCar();
      if (disposed) {
        disposeObjectTree(built.group);
        return 'aborted';
      }
      placeCar(built.group, built.partMats, Math.PI * 0.12);
      return 'procedural';
    }
  }

  let lastFrameAt = 0;
  function frame(now) {
    if(!running || disposed) return;
    animId = requestAnimationFrame(frame);
    const minDelta = drag ? 33 : 50;
    if(now - lastFrameAt < minDelta) return;
    lastFrameAt = now;
    bounceT = now * 0.001;
    if(autoSpin && !drag) yaw += 0.007;
    root.rotation.y = yaw;
    root.position.y = Math.sin(bounceT * 1.6) * 0.035;
    ring.rotation.z = -yaw * 0.35;
    camera.lookAt(0, 0.32, 0);
    renderer.render(scene, camera);
  }

  function onPointerDown(e) {
    if (disposed) return;
    drag = true;
    autoSpin = false;
    if (autoSpinTimer) { clearTimeout(autoSpinTimer); autoSpinTimer = 0; }
    lastX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
  }
  function onPointerMove(e) {
    if(!drag || disposed) return;
    const x = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : lastX);
    yaw += (x - lastX) * 0.008;
    lastX = x;
  }
  function onPointerUp() {
    if (disposed) return;
    drag = false;
    if (autoSpinTimer) clearTimeout(autoSpinTimer);
    autoSpinTimer = setTimeout(() => {
      autoSpinTimer = 0;
      if (!disposed) autoSpin = true;
    }, 1200);
  }
  function onTouchStart(e) {
    onPointerDown(e);
    e.preventDefault();
  }
  function onTouchMove(e) {
    onPointerMove(e);
    e.preventDefault();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onPointerUp);
  window.addEventListener('resize', resize);

  const api = {
    async mount(livery) {
      if (disposed) return;
      setStatus('LOADING CAR…');
      resize();
      try {
        const mode = await prepareCar();
        if (disposed || mode === 'aborted') return;
        applyLivery(livery || (typeof window.getPlayerLivery === 'function' ? window.getPlayerLivery('p1') : null));
        setStatus(mode === 'glb' ? '' : 'PROCEDURAL FALLBACK');
        this.resume();
      } catch (err) {
        console.error(err);
        if (!disposed) setStatus('CAR LOAD FAILED');
      }
    },
    setLivery(livery) { if (!disposed) applyLivery(livery); },
    resume() {
      if(disposed || running) return;
      running = true;
      resize();
      animId = requestAnimationFrame(frame);
    },
    pause() {
      running = false;
      if(animId) cancelAnimationFrame(animId);
      animId = 0;
    },
    /** Lightweight counts for leak diagnostics (listeners + tracked GPU ids). */
    getDiagnostics() {
      return {
        disposed,
        running,
        animId: !!animId,
        hasCar: !!car,
        envMap: !!(scene && scene.environment),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      this.pause();
      if (autoSpinTimer) { clearTimeout(autoSpinTimer); autoSpinTimer = 0; }

      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onPointerUp);
      window.removeEventListener('resize', resize);

      const tracker = createDisposeTracker();
      clearGroupChildren(root, tracker);
      car = null;
      partMats = emptyPartMats();

      // Scene props (ground/ring/lights) + any remaining children
      disposeObjectTree(scene, tracker);

      scene.environment = null;
      if (envTarget) {
        try { envTarget.dispose(); } catch (e) { /* ok */ }
      }

      if (key.shadow && key.shadow.map) {
        try { key.shadow.map.dispose(); } catch (e) { /* ok */ }
        key.shadow.map = null;
      }

      try { renderer.dispose(); } catch (e) { /* ok */ }
      try {
        if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
      } catch (e2) { /* ok */ }

      api._lastDisposeStats = {
        geometries: tracker.geometries.size,
        materials: tracker.materials.size,
        textures: tracker.textures.size,
      };
    },
    resize,
  };

  return api;
}

let menuStage = null;
let garageStage = null;
window._menuPaintPart = window._menuPaintPart || 'chassis';
window._garagePaintPreview = window._garagePaintPreview || 'p1';

/** Listener + loop diagnostics for Garage/menu car stages (manual leak checks). */
window.getCarStageDiagnostics = function getCarStageDiagnostics() {
  return {
    menu: menuStage ? menuStage.getDiagnostics() : null,
    garage: garageStage ? garageStage.getDiagnostics() : null,
    menuAlive: !!menuStage,
    garageAlive: !!garageStage,
    gltfCached: !!cachedGltfScene,
  };
};

// Test hooks for dispose helpers (no Three.js dependency beyond duck-typed objects).
window.__kbCarStageDispose = {
  createDisposeTracker,
  disposeTextureSafe,
  disposeMaterialSafe,
  disposeGeometrySafe,
  disposeObjectTree,
  clearGroupChildren,
};

window.buildMenuPaintStrip = function buildMenuPaintStrip() {
  const partsEl = document.getElementById('menu-paint-parts');
  const swEl = document.getElementById('menu-paint-swatches');
  if(!partsEl || !swEl || !window.PAINT_PARTS) return;
  const liv = window.getPlayerLivery('p1');
  const active = window._menuPaintPart || 'chassis';
  partsEl.innerHTML = '';
  swEl.innerHTML = '';
  window.PAINT_PARTS.forEach((part) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-paint-part' + (active === part.id ? ' sel' : '');
    b.textContent = part.label;
    b.onclick = () => {
      window._menuPaintPart = part.id;
      window.buildMenuPaintStrip();
    };
    partsEl.appendChild(b);
  });
  window.PAINT_COLORS.forEach((pc) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'paint-sw' + (liv[active] === pc.id ? ' sel' : '');
    sw.style.background = pc.body;
    sw.title = pc.label;
    sw.setAttribute('aria-label', `Paint ${pc.label}`);
    sw.setAttribute('aria-pressed', liv[active] === pc.id ? 'true' : 'false');
    sw.onclick = () => {
      window.setPlayerLiveryPart('p1', active, pc.id);
      window.buildMenuPaintStrip();
    };
    swEl.appendChild(sw);
  });
};

window.mountMenuCarStage = async function mountMenuCarStage() {
  const canvas = document.getElementById('menu-car-canvas');
  if(!canvas) return;
  if(!menuStage) {
    menuStage = createCarStage(canvas, { statusEl: document.getElementById('menu-car-status') });
    await menuStage.mount(window.getPlayerLivery('p1'));
  } else {
    menuStage.setLivery(window.getPlayerLivery('p1'));
    menuStage.resume();
  }
  window.buildMenuPaintStrip();
};

window.pauseMenuCarStage = function pauseMenuCarStage() {
  if(menuStage) menuStage.pause();
};

window.mountGarageCarStage = async function mountGarageCarStage() {
  const canvas = document.getElementById('garage-car-canvas');
  if(!canvas) return;
  if(garageStage) {
    garageStage.dispose();
    garageStage = null;
  }
  garageStage = createCarStage(canvas);
  const preview = window._garagePaintPreview === 'p2' ? 'p2' : 'p1';
  await garageStage.mount(window.getPlayerLivery(preview));
};

window.disposeGarageCarStage = function disposeGarageCarStage() {
  if(garageStage) {
    garageStage.dispose();
    garageStage = null;
  }
};

window.refreshCarStages = function refreshCarStages() {
  if(menuStage) menuStage.setLivery(window.getPlayerLivery('p1'));
  if(garageStage) {
    const preview = window._garagePaintPreview === 'p2' ? 'p2' : 'p1';
    garageStage.setLivery(window.getPlayerLivery(preview));
  }
  if(typeof window.buildMenuPaintStrip === 'function') window.buildMenuPaintStrip();
};

// Auto-mount if menu is already visible
if(document.getElementById('screen-menu') && !document.getElementById('screen-menu').classList.contains('hidden')) {
  window.mountMenuCarStage();
}
