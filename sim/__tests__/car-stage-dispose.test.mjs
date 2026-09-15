/**
 * Lightweight tests for Garage/car-stage dispose helpers.
 * Duck-typed Three.js objects — no WebGL required.
 */
import assert from "assert";

function makeTracker() {
  return { geometries: new Set(), materials: new Set(), textures: new Set() };
}

function disposeTextureSafe(tex, tracker) {
  if (!tex || !tex.isTexture) return;
  if (tracker.textures.has(tex.uuid)) return;
  if (!tex.userData || !tex.userData.ownedByStage) return;
  tracker.textures.add(tex.uuid);
  tex.dispose();
}

function disposeMaterialSafe(mat, tracker) {
  if (!mat) return;
  if (tracker.materials.has(mat.uuid)) return;
  tracker.materials.add(mat.uuid);
  disposeTextureSafe(mat.map, tracker);
  mat.dispose();
}

function disposeGeometrySafe(geo, tracker) {
  if (!geo) return;
  if (tracker.geometries.has(geo.uuid)) return;
  tracker.geometries.add(geo.uuid);
  geo.dispose();
}

function disposeObjectTree(root, tracker) {
  const t = tracker || makeTracker();
  const stack = [root];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj) continue;
    if (obj.children) for (let i = 0; i < obj.children.length; i++) stack.push(obj.children[i]);
    if (obj.geometry) disposeGeometrySafe(obj.geometry, t);
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (let i = 0; i < mats.length; i++) disposeMaterialSafe(mats[i], t);
    }
  }
  return t;
}

function uuid() {
  return "id-" + Math.random().toString(16).slice(2);
}

{
  // Shared (non-owned) GLTF texture must survive material dispose
  let sharedDisposed = 0;
  const sharedTex = {
    isTexture: true,
    uuid: uuid(),
    userData: {},
    dispose() { sharedDisposed++; },
  };
  let matDisposed = 0;
  const mat = {
    uuid: uuid(),
    map: sharedTex,
    dispose() { matDisposed++; },
  };
  const tracker = makeTracker();
  disposeMaterialSafe(mat, tracker);
  disposeMaterialSafe(mat, tracker); // double-dispose safe
  assert.equal(matDisposed, 1);
  assert.equal(sharedDisposed, 0);
  assert.equal(tracker.materials.size, 1);
  assert.equal(tracker.textures.size, 0);
}

{
  // Owned stage texture is freed once
  let ownedDisposed = 0;
  const ownedTex = {
    isTexture: true,
    uuid: uuid(),
    userData: { ownedByStage: true },
    dispose() { ownedDisposed++; },
  };
  const mat = {
    uuid: uuid(),
    map: ownedTex,
    dispose() {},
  };
  const tracker = makeTracker();
  disposeMaterialSafe(mat, tracker);
  disposeTextureSafe(ownedTex, tracker);
  assert.equal(ownedDisposed, 1);
  assert.equal(tracker.textures.size, 1);
}

{
  // Shared geometry across meshes disposed once
  let geoDisposed = 0;
  const geo = { uuid: uuid(), dispose() { geoDisposed++; } };
  const root = {
    children: [
      { geometry: geo, material: { uuid: uuid(), dispose() {} }, children: [] },
      { geometry: geo, material: { uuid: uuid(), dispose() {} }, children: [] },
    ],
  };
  // flatten: disposeObjectTree expects traverse-like; our stack walks children
  const tracker = disposeObjectTree(root);
  assert.equal(geoDisposed, 1);
  assert.equal(tracker.geometries.size, 1);
  assert.equal(tracker.materials.size, 2);
}

console.log("car-stage-dispose: ok");
