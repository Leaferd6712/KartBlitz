import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';


const CAR_MODEL_URL = './rb6.glb';

let cachedGltfScene = null;
let modelPromise;
const gltfLoader = new GLTFLoader();

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

  // Keep the original mesh, vertex attributes and transforms. Only group its
  // existing triangles into independently coloured draw ranges.
  const materials=[], indices=[];
  src.clearGroups();
  for(const part of ['chassis','frontWing','nose','rearWing']) {
    if(!buckets[part].length)continue;
    const material=cloneLiveryMaterial(mesh.material);
    src.addGroup(indices.length,buckets[part].length,materials.length);
    for(const index of buckets[part])indices.push(index);
    materials.push(material);mats[part].push(material);
  }
  src.setIndex(indices);const originalMaterial=mesh.material;mesh.material=materials;originalMaterial.dispose();
}

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
  // Direct lights keep the small preview light enough for school laptops.
  const envTarget = null;

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);
  camera.position.set(2.85, 1.15, 3.85);

  const hemi = new THREE.HemisphereLight(0xb8e6ff, 0x1a1520, 1.15);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.85);
  key.position.set(4.2, 7.5, 3.2);
  key.castShadow = true;
  key.shadow.mapSize.set(512, 512);
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
    const scale = 3.2 / Math.max(size.x, size.y, size.z, 0.001);
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
    const pc=window.getPaintColor(paintId);
    // Remove livery graphics, retaining the GLB's physical surface properties.
    mat.map=null;mat.emissiveMap=null;
    mat.color.set(pc.body);
    if(mat.emissive)mat.emissive.set(0x000000);
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
    modelPromise ||= gltfLoader.loadAsync(CAR_MODEL_URL).then(gltf=>(cachedGltfScene=gltf.scene)).catch(error=>{modelPromise=null;throw error;});
    const source=await modelPromise;
    if(disposed)return 'aborted';
    const model=source.clone(true);
    model.traverse(object=>{
      if(!object.isMesh)return;
      object.geometry=object.geometry.clone();
      object.material=Array.isArray(object.material)?object.material.map(m=>m.clone()):object.material.clone();
    });
    const mats=mapGlbMaterials(model);
    placeCar(model,mats,Math.PI*.15);
    return 'rb6.glb';
  }

  let lastFrameAt = 0;
  function frame(now) {
    if(!running || disposed) return;
    animId = requestAnimationFrame(frame);
    const minDelta = drag ? 33 : 50;
    if(now - lastFrameAt < minDelta) return;
    lastFrameAt = now;
    bounceT = now * 0.001;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.reducedMotion === '1';
    if(autoSpin && !drag && !reducedMotion) yaw += 0.007;
    root.rotation.y = yaw;
    root.position.y = reducedMotion ? 0 : Math.sin(bounceT * 1.6) * 0.035;
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
        setStatus('DRAG TO EXPLORE YOUR KART');
        canvas.dataset.model=mode;
        canvas.closest('.menu-car-stage,.garage-car-stage')?.setAttribute('data-ready','true');
        window.dispatchEvent(new Event('kb:preview-ready'));
        this.resume();
      } catch (err) {
        console.warn('KartBlitz model unavailable:',err.message);
        if (!disposed) setStatus('YOUR KART IS READY TO RACE');
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
        model: canvas.dataset.model,
        colours: Object.fromEntries(Object.entries(partMats).filter(([,mats])=>mats.length).map(([part,mats])=>[part,mats.map(mat=>'#'+mat.color.getHexString().toUpperCase())])),
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
    try {
      menuStage = createCarStage(canvas, { statusEl: document.getElementById('menu-car-status') });
      await menuStage.mount(window.getPlayerLivery('p1'));
    } catch (error) {
      console.warn('[KartBlitz preview] Using the static kart:',error.message);
      menuStage?.dispose(); menuStage = null;
      document.getElementById('menu-car-stage')?.classList.add('preview-fallback');
      document.getElementById('menu-car-status').textContent = 'YOUR KART IS READY TO RACE';
    }
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
  try {
    garageStage = createCarStage(canvas);
    const preview = window._garagePaintPreview === 'p2' ? 'p2' : 'p1';
    await garageStage.mount(window.getPlayerLivery(preview));
  } catch { garageStage?.dispose(); garageStage = null; }
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
