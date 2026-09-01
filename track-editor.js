window.KartBlitzTrackEditor = (function(){
  const LS_KEY = 'kartblitz_track_editor_project';
  const TE_PASS = 'kartblitz';
  const TE_SESSION_KEY = 'kartblitz_te_unlocked';
  let _open = false;
  let _editIndex = null; // null = new track
  let _bound = false;
  let _exportTimer = null;
  const api = {
    isOpen() { return _open; },
    isUnlocked() {
      try { return sessionStorage.getItem(TE_SESSION_KEY) === '1'; } catch(e) { return false; }
    },
    setUnlocked(v) {
      try { sessionStorage.setItem(TE_SESSION_KEY, v ? '1' : '0'); } catch(e) {}
    }
  };
  // Publish immediately so the menu button works even if later init throws.
  window.KartBlitzTrackEditor = api;

  function $(id) { return document.getElementById(id); }

  function showPassModal(show) {
    const m = $('te-pass-modal');
    if (!m) return;
    m.classList.toggle('open', !!show);
    m.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) {
      const inp = $('te-pass-input');
      const err = $('te-pass-err');
      if (err) err.textContent = '';
      if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 50); }
    }
  }

  function showPicker(show) {
    const el = $('screen-te-picker');
    if (!el) return;
    el.classList.toggle('open', !!show);
    el.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) buildPicker();
  }

  function openPicker() {
    if (typeof window.pauseMenuCarStage === 'function') window.pauseMenuCarStage();
    if (typeof showScreen === 'function') {
      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    }
    showPassModal(false);
    showPicker(true);
  }

  function showEditor(show) {
    const el = $('screen-te-editor');
    if (!el) return;
    el.classList.toggle('open', !!show);
    el.setAttribute('aria-hidden', show ? 'false' : 'true');
    _open = !!show;
    if (show) {
      try {
        ensureBound();
        startExportTimer();
        syncUI();
      } catch (err) {
        console.error('Track editor open bind failed:', err);
      }
      // Wait for layout after display:none → flex before measuring canvas size
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            fitEditorView(true);
            refreshExport();
          } catch (err) {
            console.error('Track editor fit failed:', err);
          }
        });
      });
    } else {
      stopExportTimer();
    }
  }

  function buildPicker() {
    const grid = $('te-picker-grid');
    if (!grid || typeof TRACKS === 'undefined') return;
    grid.innerHTML = '';
    TRACKS.forEach((t, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'te-pick-card';
      card.innerHTML = '<div class="te-pick-name">' + (t.name || ('TRACK ' + t.id)) + '</div>' +
        '<div class="te-pick-meta">ID ' + t.id + ' · ' + (t.difficulty || '?') + '</div>';
      card.onclick = () => openTrackAt(i);
      grid.appendChild(card);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'te-pick-card te-pick-add';
    add.innerHTML = '<div class="te-pick-name">+ ADD NEW TRACK</div><div class="te-pick-meta">START FROM TEMPLATE</div>';
    add.onclick = () => openNewTrack();
    grid.appendChild(add);
  }

  function trackToProject(tr) {
    const wps = (tr.authoredWaypoints || tr.waypoints || []).map(clonePtsSingle);
    const rl = tr.authoredRacingLine
      ? tr.authoredRacingLine.map(p => ({ x: p.x, y: p.y }))
      : [];
    const pitRaw = (tr.pitLane && (tr.pitLane.rawPath || tr.pitLane.path)) || [];
    const width = tr.authoredBaseWidth != null ? tr.authoredBaseWidth : tr.trackWidth;
    return {
      version: 1,
      type: 'kartblitz-track-editor',
      closed: true,
      waypoints: wps,
      racingLine: rl,
      meta: {
        id: tr.id,
        name: tr.name,
        difficulty: tr.difficulty || 'MEDIUM',
        trackWidth: width,
        laps: tr.laps || 3,
        targetLap: tr.targetLap || 60,
        coinMult: tr.coinMult != null ? tr.coinMult : 1.5,
        grassColor: tr.grassColor || '#173012',
        grassColor2: tr.grassColor2 || '#1e3e18',
        trackColor: tr.trackColor || '#2e2e2e',
        borderColor: tr.borderColor || '#ff9500',
        lineColor: tr.lineColor || '#ffffff',
        accentColor: tr.accentColor || '#ff6b35',
        bgColor: tr.bgColor || '#0f1a08',
        startPos: tr.startPos ? { x: tr.startPos.x, y: tr.startPos.y } : { x: 1200, y: 5200 },
        startAngle: tr.startAngle || 0,
        pitPos: tr.pitPos ? { x: tr.pitPos.x, y: tr.pitPos.y } : { x: 900, y: 5020 },
        pitLane: {
          path: pitRaw.map(p => ({ x: p.x, y: p.y })),
          entryPt: tr.pitLane && tr.pitLane.entryPt ? { ...tr.pitLane.entryPt } : null,
          garagePos: tr.pitLane && tr.pitLane.garagePos ? { ...tr.pitLane.garagePos } : null,
          garageAngle: 0,
          exitPos: tr.pitLane && tr.pitLane.exitPos ? { ...tr.pitLane.exitPos } : null,
          exitAngle: 0,
          width: (tr.pitLane && tr.pitLane.width) || 56
        },
        cpFracs: (tr.cpFracs || []).slice(),
        drsFracs: (tr.drsFracs || []).map(p => [p[0], p[1]]),
        sfGateHalfWidth: (tr.sfGateHalfWidth != null && isFinite(tr.sfGateHalfWidth) && tr.sfGateHalfWidth > 0)
          ? tr.sfGateHalfWidth : null,
        surface: tr.surface ? { ...tr.surface } : { offTrackMult: 1.0, label: 'GRASS' },
        aiFriendly: !!tr.aiFriendly,
        locked: !!tr.locked,
        unlockCost: tr.unlockCost || 0,
        treeColor: tr.treeColor,
        treeColor2: tr.treeColor2,
        standRoof: tr.standRoof,
        standConcrete: tr.standConcrete,
        seatPalette: tr.seatPalette,
        crowdColors: tr.crowdColors,
        aiBrakeLookaheadScale: tr.aiBrakeLookaheadScale
      }
    };
  }

  function clonePtsSingle(p) {
    const o = { x: p.x, y: p.y };
    const b = normalizeBrakeTag(p.brake);
    if (b > 0) o.brake = b;
    else if (p.brake != null) o.brake = 0;
    return o;
  }

  function trackLayoutForImport(tr) {
    const wps = (tr.authoredWaypoints || tr.waypoints || []).map(p => {
      const o = { x: Math.round(p.x), y: Math.round(p.y) };
      const b = normalizeBrakeTag(p.brake);
      if (b > 0) o.brake = b;
      return o;
    });
    const rlSrc = tr.authoredRacingLine || tr.racingLine;
    const rl = Array.isArray(rlSrc) && rlSrc.length >= 3
      ? rlSrc.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
      : [];
    const pitRaw = (tr.pitLane && (tr.pitLane.rawPath || tr.pitLane.path)) || [];
    const width = tr.authoredBaseWidth != null ? tr.authoredBaseWidth : tr.trackWidth;
    const obj = {
      id: tr.id,
      name: tr.name || ('TRACK ' + tr.id),
      difficulty: tr.difficulty || 'MEDIUM',
      trackWidth: width,
      laps: tr.laps || 3,
      targetLap: tr.targetLap || 60,
      waypoints: wps,
      startPos: tr.startPos ? { x: Math.round(tr.startPos.x), y: Math.round(tr.startPos.y) } : { x: 1200, y: 5200 },
      startAngle: tr.startAngle || 0,
      cpFracs: (tr.cpFracs || []).slice(),
      drsFracs: (tr.drsFracs || []).map(p => [p[0], p[1]]),
      pitLane: {
        path: pitRaw.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        width: (tr.pitLane && tr.pitLane.width) || 56
      },
      surface: tr.surface ? { ...tr.surface } : { offTrackMult: 1.0, label: 'GRASS' }
    };
    if (rl.length) obj.racingLine = rl;
    if (tr.sfGateHalfWidth != null && isFinite(tr.sfGateHalfWidth) && tr.sfGateHalfWidth > 0) {
      obj.sfGateHalfWidth = tr.sfGateHalfWidth;
    }
    return JSON.stringify(obj, null, 2);
  }

  function openTrackAt(idx) {
    ensureBound();
    _editIndex = idx;
    const tr = TRACKS[idx];
    showPicker(false);
    showEditor(true);
    // Same workflow as the standalone editor: put layout in Import, then load it.
    const payload = trackLayoutForImport(tr);
    const area = document.getElementById('te-importArea');
    if (area) area.value = payload;
    try {
      applyImport(parseCoordinateText(payload));
      setMsg('Loaded track layout: ' + (tr.name || ('#' + tr.id)));
    } catch (err) {
      console.error(err);
      setMsg('Load failed: ' + err.message);
      alert('Failed to load track into editor: ' + err.message);
    }
  }

  function openNewTrack() {
    ensureBound();
    _editIndex = null;
    showPicker(false);
    showEditor(true);
    const d = defaultProject();
    const used = new Set(TRACKS.map(t => t.id));
    let nid = 0;
    while (used.has(nid)) nid++;
    d.meta.id = nid;
    d.meta.name = 'NEW CIRCUIT ' + nid;
    state.waypoints = clonePts(d.waypoints);
    state.racingLine = clonePts(d.racingLine || []);
    state.pitPath = clonePts((d.meta.pitLane && d.meta.pitLane.path) || []);
    state.closed = true;
    state.selected.clear();
    applyMetaToForm(d.meta);
    syncUI();
    requestAnimationFrame(() => fitEditorView(true));
    refreshExport();
    setMsg('New track template — Apply to add to game');
  }

  function pathAngleAt(path, idx) {
    if (!path || path.length < 2) return 0;
    let a, b;
    if (idx <= 0) { a = path[0]; b = path[1]; }
    else if (idx >= path.length - 1) { a = path[path.length - 2]; b = path[path.length - 1]; }
    else { a = path[idx - 1]; b = path[idx + 1]; }
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  function buildTrackObjectFromEditor() {
    const meta = readMetaFromForm();
    const wps = state.waypoints.map(p => ({
      x: Math.round(p.x), y: Math.round(p.y), brake: normalizeBrakeTag(p.brake)
    }));
    const pitPath = (state.pitPath && state.pitPath.length
      ? state.pitPath
      : (meta.pitLane.path || [])).map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    const entry = pitPath[0] || { x: meta.startPos.x, y: meta.startPos.y };
    const exit = pitPath[pitPath.length - 1] || entry;
    const garageIdx = Math.floor(pitPath.length / 2);
    const garage = pitPath[garageIdx] || entry;
    const garageAngle = pathAngleAt(pitPath, garageIdx);
    const exitAngle = pathAngleAt(pitPath, pitPath.length - 1);
    const existing = _editIndex != null ? TRACKS[_editIndex] : null;
    const id = existing ? existing.id : meta.id;
    const pitWidth = (meta.pitLane && meta.pitLane.width) || (existing && existing.pitLane && existing.pitLane.width) || 56;
    const obj = {
      id,
      name: meta.name,
      difficulty: meta.difficulty,
      diffClass: meta.diffClass,
      diffLetter: meta.diffLetter,
      targetLap: meta.targetLap,
      laps: meta.laps,
      trackWidth: meta.trackWidth,
      lapDistance: 0,
      coinMult: existing && existing.coinMult != null ? existing.coinMult : meta.coinMult,
      grassColor: (existing && existing.grassColor) || meta.grassColor,
      grassColor2: (existing && existing.grassColor2) || meta.grassColor2,
      trackColor: (existing && existing.trackColor) || meta.trackColor,
      borderColor: (existing && existing.borderColor) || meta.borderColor,
      lineColor: (existing && existing.lineColor) || meta.lineColor,
      accentColor: (existing && existing.accentColor) || meta.accentColor,
      bgColor: (existing && existing.bgColor) || meta.bgColor,
      waypoints: wps,
      startPos: { x: Math.round(meta.startPos.x), y: Math.round(meta.startPos.y) },
      startAngle: meta.startAngle,
      pitPos: { x: Math.round(garage.x), y: Math.round(garage.y) },
      pitLane: {
        path: pitPath,
        entryPt: { x: entry.x, y: entry.y },
        garagePos: { x: garage.x, y: garage.y },
        garageAngle,
        exitPos: { x: exit.x, y: exit.y },
        exitAngle,
        width: pitWidth
      },
      cpFracs: meta.cpFracs.slice(),
      drsFracs: meta.drsFracs.map(p => [p[0], p[1]]),
      surface: meta.surface
    };
    if (meta.sfGateHalfWidth != null && isFinite(meta.sfGateHalfWidth) && meta.sfGateHalfWidth > 0) {
      obj.sfGateHalfWidth = meta.sfGateHalfWidth;
    }
    if (state.racingLine.length >= 3) {
      obj.racingLine = state.racingLine.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    }
    if (existing) {
      if (existing.aiFriendly) obj.aiFriendly = true;
      if (existing.locked) { obj.locked = true; obj.unlockCost = existing.unlockCost; }
      if (existing.treeColor) obj.treeColor = existing.treeColor;
      if (existing.treeColor2) obj.treeColor2 = existing.treeColor2;
      if (existing.standRoof) obj.standRoof = existing.standRoof;
      if (existing.standConcrete) obj.standConcrete = existing.standConcrete;
      if (existing.seatPalette) obj.seatPalette = existing.seatPalette;
      if (existing.crowdColors) obj.crowdColors = existing.crowdColors;
      if (existing.aiBrakeLookaheadScale != null) obj.aiBrakeLookaheadScale = existing.aiBrakeLookaheadScale;
    }
    return obj;
  }

  function applyToGame() {
    if (state.waypoints.length < 3) {
      setMsg('Need at least 3 waypoints');
      alert('Need at least 3 waypoints to apply.');
      return;
    }
    const obj = buildTrackObjectFromEditor();
    // Seed authored fields then finalize
    obj.authoredWaypoints = obj.waypoints.map(clonePtsSingle);
    obj.authoredRacingLine = obj.racingLine && obj.racingLine.length >= 3
      ? obj.racingLine.map(p => ({ x: p.x, y: p.y }))
      : null;
    obj.authoredBaseWidth = obj.trackWidth;

    if (_editIndex == null) {
      TRACKS.push(obj);
      _editIndex = TRACKS.length - 1;
      try {
        const pd = getPlayerData();
        if (pd && Array.isArray(pd.unlockedTracks) && !pd.unlockedTracks.includes(obj.id)) {
          pd.unlockedTracks = pd.unlockedTracks.concat([obj.id]);
          savePlayerData(pd);
        }
      } catch (e) {}
    } else {
      // Replace in place keeping array identity for this slot
      const slot = TRACKS[_editIndex];
      Object.keys(slot).forEach(k => { delete slot[k]; });
      Object.assign(slot, obj);
    }

    finalizeTrack(TRACKS[_editIndex]);
    invalidateTrackBaseCache();
    try {
      const el = document.getElementById('portal-track-count');
      if (el) el.textContent = TRACKS.length + 'TRACKS';
    } catch (e) {}
    const permanentHint = (typeof window.onTrackEditorApply === 'function')
      ? window.onTrackEditorApply()
      : 'Applied to session — Copy/Download export and paste into tracks-shared.js to ship permanently.';
    setMsg(permanentHint);
    refreshExport();
  }

  function closeAll() {
    showEditor(false);
    showPicker(false);
    showPassModal(false);
    if (typeof window.onTrackEditorClose === 'function') {
      window.onTrackEditorClose();
      return;
    }
    if (typeof showScreen === 'function') showScreen('menu');
  }

  function requestOpen() {
    if (typeof window.pauseMenuCarStage === 'function') window.pauseMenuCarStage();
    if (api.isUnlocked()) {
      openPicker();
      return;
    }
    showPassModal(true);
  }
  api.requestOpen = requestOpen;
  api.openPicker = openPicker;
  api.buildPicker = buildPicker;

  function tryPass() {
    const inp = $('te-pass-input');
    const err = $('te-pass-err');
    const val = (inp && inp.value || '').trim().toLowerCase();
    if (val === TE_PASS) {
      api.setUnlocked(true);
      openPicker();
    } else {
      if (err) err.textContent = 'INCORRECT PASSCODE';
      if (inp) { inp.value = ''; inp.focus(); }
    }
  }

  function startExportTimer() {
    if (_exportTimer) return;
    _exportTimer = setInterval(() => {
      if (!_open) return;
      if (document.activeElement === document.getElementById('te-exportArea')) return;
      try { refreshExport(); } catch (e) {}
    }, 2000);
  }
  function stopExportTimer() {
    if (_exportTimer) { clearInterval(_exportTimer); _exportTimer = null; }
  }

  function ensureBound() {
    if (_bound) return;
    _bound = true;
    bindEditorChrome();
  }

  function bindEditorChrome() {
    const root = $('screen-te-editor');
    // Wire apply / nav (editor-specific controls)
    const btnApply = $('te-btnApplyGame');
    if (btnApply) btnApply.onclick = () => applyToGame();
    const btnBack = $('te-btnBackPicker');
    if (btnBack) btnBack.onclick = () => { showEditor(false); showPicker(true); };
    const editorBack = $('te-editor-back');
    if (editorBack) editorBack.onclick = () => { showEditor(false); showPicker(true); };
    const btnClose = $('te-btnCloseEditor');
    if (btnClose) btnClose.onclick = () => closeAll();

    // Rebind toolbar with root scope if needed
    root.querySelectorAll('#te-toolbar [data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });
  }

  function bindPassUi() {
    const ok = $('te-pass-ok');
    const cancel = $('te-pass-cancel');
    const passBack = $('te-pass-back');
    const inp = $('te-pass-input');
    if (ok) ok.onclick = tryPass;
    if (cancel) cancel.onclick = () => showPassModal(false);
    if (passBack) passBack.onclick = () => showPassModal(false);
    if (inp) inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') tryPass();
      if (e.key === 'Escape') showPassModal(false);
    });
    const pickerBack = $('te-picker-back');
    if (pickerBack) pickerBack.onclick = () => closeAll();
  }


// Preview-only helpers (not on game globals)
function buildCum(spline) {
  const cum = [0];
  for (let i = 1; i < spline.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(spline[i].x - spline[i - 1].x, spline[i].y - spline[i - 1].y);
  }
  if (spline.length > 1) {
    cum.push(cum[cum.length - 1] + Math.hypot(spline[0].x - spline[spline.length - 1].x, spline[0].y - spline[spline.length - 1].y));
  }
  return cum;
}
function fracToSplineIndex(cum, frac) {
  if (!cum.length) return 0;
  const total = cum[cum.length - 1] || 1;
  const target = ((frac % 1) + 1) % 1 * total;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1; else hi = mid;
  }
  return Math.min(lo, Math.max(0, (cum.length > 1 ? cum.length - 2 : 0)));
}
// ── Editor state ────────────────────────────────────────────────────────────
const canvas = document.getElementById('te-canvas');
  if (!canvas) { console.warn('Track editor canvas missing'); }
  const ctx = canvas ? canvas.getContext('2d') : null;
  const root = document.getElementById('screen-te-editor');
const state = {
  waypoints: [],
  racingLine: [],
  pitPath: [],
  editLayer: 'waypoints', // 'waypoints' | 'racingLine' | 'pitPath'
  closed: true,
  tool: 'select',
  selected: new Set(),
  cam: { x: 2600, y: 3200, zoom: 0.22 },
  gridSize: 100,
  snap: false,
  showGrid: true,
  showNodes: true,
  showLine: true,
  showRace: true,
  showAILine: true,
  showRemap: false,
  showPit: true,
  showDir: true,
  showCp: true,
  dragging: null,
  pan: null,
  box: null,
  spaceDown: false,
  cursorWorld: null,
  undoStack: [],
  redoStack: [],
  dirty: false
};

function activePts() {
  if (state.editLayer === 'racingLine') return state.racingLine;
  if (state.editLayer === 'pitPath') return state.pitPath;
  return state.waypoints;
}

function setEditLayer(layer) {
  state.editLayer = layer;
  state.selected.clear();
  const trackBtn = document.getElementById('te-btnLayerTrack');
  const aiBtn = document.getElementById('te-btnLayerAI');
  const pitBtn = document.getElementById('te-btnLayerPit');
  if (trackBtn) trackBtn.classList.toggle('active', layer === 'waypoints');
  if (aiBtn) aiBtn.classList.toggle('active', layer === 'racingLine');
  if (pitBtn) pitBtn.classList.toggle('active', layer === 'pitPath');
  if (layer === 'pitPath') state.showPit = true;
  syncUI(); render();
}

function syncPitPathToForm() {
  const el = document.getElementById('te-pitPath');
  if (el) el.value = JSON.stringify((state.pitPath || []).map(p => ({
    x: Math.round(p.x), y: Math.round(p.y)
  })));
}

function loadPitPathFromForm() {
  const el = document.getElementById('te-pitPath');
  let pitPath = [];
  try { pitPath = JSON.parse(el ? el.value : '[]'); } catch (e) { pitPath = []; }
  if (!Array.isArray(pitPath)) pitPath = [];
  state.pitPath = pitPath.map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
}

function defaultProject() {
  const wps = [
    { x: 800, y: 5200 }, { x: 1600, y: 5200 }, { x: 2400, y: 5200 }, { x: 3200, y: 5200 },
    { x: 3600, y: 4800 }, { x: 3800, y: 4200 }, { x: 3800, y: 3600 }, { x: 3400, y: 3200 },
    { x: 2800, y: 3000 }, { x: 2000, y: 3000 }, { x: 1400, y: 3200 }, { x: 1000, y: 3600 },
    { x: 800, y: 4200 }, { x: 700, y: 4800 }
  ];
  return {
    version: 1,
    closed: true,
    waypoints: wps,
    racingLine: clonePts(wps),
    meta: {
      id: 12, name: 'MY CIRCUIT', difficulty: 'MEDIUM', trackWidth: 120, laps: 3, targetLap: 60, coinMult: 1.5,
      grassColor: '#173012', grassColor2: '#1e3e18', trackColor: '#2e2e2e', borderColor: '#ff9500',
      lineColor: '#ffffff', accentColor: '#ff6b35', bgColor: '#0f1a08',
      startPos: { x: 1200, y: 5200 }, startAngle: 0,
      pitPos: { x: 900, y: 5020 },
      pitLane: {
        path: [{ x: 900, y: 5200 }, { x: 900, y: 5020 }, { x: 1600, y: 5020 }, { x: 2300, y: 5020 }, { x: 2300, y: 5200 }],
        entryPt: { x: 900, y: 5200 }, garagePos: { x: 1600, y: 5020 }, garageAngle: 0,
        exitPos: { x: 2300, y: 5200 }, exitAngle: 0, width: 56
      },
      cpFracs: [0.0, 0.15, 0.30, 0.45, 0.60, 0.75, 0.90],
      drsFracs: [[0.02, 0.12], [0.50, 0.60]],
      sfGateHalfWidth: null,
      surface: { offTrackMult: 1.0, label: 'GRASS' }
    }
  };
}

function normalizeBrakeTag(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(5, Math.round(n)));
}

function clonePts(pts) {
  return (pts || []).map(p => {
    const o = { x: p.x, y: p.y };
    const b = normalizeBrakeTag(p.brake);
    if (b > 0) o.brake = b;
    else if (p.brake != null) o.brake = 0;
    return o;
  });
}

function formatWpJS(p) {
  const b = normalizeBrakeTag(p.brake);
  return `{x:${Math.round(p.x)},y:${Math.round(p.y)},brake:${b}}`;
}

function captureMetaSnap() {
  const meta = readMetaFromForm();
  return {
    pitPath: clonePts(state.pitPath),
    cpFracs: (meta.cpFracs || []).slice(),
    startPos: meta.startPos ? { x: meta.startPos.x, y: meta.startPos.y } : { x: 0, y: 0 },
    startAngle: meta.startAngle || 0,
    sfGateHalfWidth: meta.sfGateHalfWidth,
    pitWidth: (meta.pitLane && meta.pitLane.width) || 56
  };
}

function restoreMetaSnap(m) {
  if (!m) return;
  if (m.pitPath) {
    state.pitPath = clonePts(m.pitPath);
    syncPitPathToForm();
  }
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el != null && val != null) el.value = val;
  };
  if (m.cpFracs) set('te-cpFracs', m.cpFracs.join(', '));
  if (m.startPos) {
    set('te-startX', m.startPos.x);
    set('te-startY', m.startPos.y);
  }
  if (m.startAngle != null) set('te-startAngle', m.startAngle);
  const hwEl = document.getElementById('te-sfGateHalfWidth');
  if (hwEl) hwEl.value = (m.sfGateHalfWidth != null && m.sfGateHalfWidth > 0) ? m.sfGateHalfWidth : '';
  if (m.pitWidth != null) set('te-pitWidth', m.pitWidth);
}

function pushUndo() {
  state.undoStack.push({
    waypoints: clonePts(state.waypoints),
    racingLine: clonePts(state.racingLine),
    closed: state.closed,
    meta: captureMetaSnap()
  });
  if (state.undoStack.length > 100) state.undoStack.shift();
  state.redoStack = [];
  state.dirty = true;
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push({
    waypoints: clonePts(state.waypoints),
    racingLine: clonePts(state.racingLine),
    closed: state.closed,
    meta: captureMetaSnap()
  });
  const snap = state.undoStack.pop();
  state.waypoints = snap.waypoints;
  state.racingLine = snap.racingLine || [];
  state.closed = snap.closed;
  restoreMetaSnap(snap.meta);
  state.selected.clear();
  syncUI(); render();
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push({
    waypoints: clonePts(state.waypoints),
    racingLine: clonePts(state.racingLine),
    closed: state.closed,
    meta: captureMetaSnap()
  });
  const snap = state.redoStack.pop();
  state.waypoints = snap.waypoints;
  state.racingLine = snap.racingLine || [];
  state.closed = snap.closed;
  restoreMetaSnap(snap.meta);
  state.selected.clear();
  syncUI(); render();
}

function loadProject(proj) {
  if (!proj || !Array.isArray(proj.waypoints)) throw new Error('Invalid project');
  state.waypoints = clonePts(proj.waypoints);
  state.racingLine = Array.isArray(proj.racingLine) ? clonePts(proj.racingLine)
    : (proj.meta && Array.isArray(proj.meta.racingLine) ? clonePts(proj.meta.racingLine) : []);
  state.closed = proj.closed !== false;
  state.selected.clear();
  if (proj.meta) applyMetaToForm(proj.meta);
  else loadPitPathFromForm();
  syncUI();
  requestAnimationFrame(() => fitEditorView(true));
  setMsg('Project loaded');
}

function readMetaFromForm() {
  const get = (id, fallback) => {
    const el = document.getElementById(id);
    return el ? el.value : fallback;
  };
  const diff = get('te-metaDiff', 'MEDIUM');
  const diffMap = { EASY: ['diff-easy', 'e'], MEDIUM: ['diff-med', 'm'], HARD: ['diff-hard', 'h'] };
  const [diffClass, diffLetter] = diffMap[diff] || diffMap.MEDIUM;
  let pitPath = [];
  if (state.pitPath && state.pitPath.length) {
    pitPath = state.pitPath.map(p => ({ x: p.x, y: p.y }));
  } else {
    try { pitPath = JSON.parse(get('te-pitPath', '[]')); } catch (e) { pitPath = []; }
  }
  if (!Array.isArray(pitPath)) pitPath = [];
  const cpFracs = String(get('te-cpFracs', '0,0.5')).split(/[, ]+/).map(Number).filter(n => !isNaN(n));
  const drsFracs = String(get('te-drsFracs', '')).split(';').map(s => {
    const m = s.trim().match(/([\d.]+)\s*-\s*([\d.]+)/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }).filter(Boolean);
  const sx = Number(get('te-startX', 1200)) || 0;
  const sy = Number(get('te-startY', 5200)) || 0;
  const entry = pitPath[0] || { x: sx, y: sy };
  const exit = pitPath[pitPath.length - 1] || entry;
  const garage = pitPath[Math.floor(pitPath.length / 2)] || entry;
  const pitWidth = Number(get('te-pitWidth', 56)) || 56;
  const sfRaw = get('te-sfGateHalfWidth', '');
  const sfGateHalfWidth = (sfRaw !== '' && sfRaw != null && isFinite(Number(sfRaw)) && Number(sfRaw) > 0)
    ? Number(sfRaw) : null;
  return {
    id: 12,
    name: get('te-metaName', 'MY CIRCUIT') || 'MY CIRCUIT',
    difficulty: diff, diffClass, diffLetter,
    targetLap: Number(get('te-metaTarget', 60)) || 60,
    laps: Number(get('te-metaLaps', 3)) || 3,
    trackWidth: Number(get('te-metaWidth', 120)) || 120,
    lapDistance: 0,
    coinMult: 1.5,
    grassColor: '#173012', grassColor2: '#1e3e18', trackColor: '#2e2e2e', borderColor: '#ff9500',
    lineColor: '#ffffff', accentColor: '#ff6b35', bgColor: '#0f1a08',
    startPos: { x: sx, y: sy },
    startAngle: Number(get('te-startAngle', 0)) || 0,
    pitPos: { x: garage.x, y: garage.y },
    pitLane: {
      path: pitPath,
      entryPt: { x: entry.x, y: entry.y },
      garagePos: { x: garage.x, y: garage.y }, garageAngle: 0,
      exitPos: { x: exit.x, y: exit.y }, exitAngle: 0, width: pitWidth
    },
    cpFracs, drsFracs,
    sfGateHalfWidth,
    surface: { offTrackMult: 1.0, label: 'GRASS' }
  };
}

function applyMetaToForm(meta) {
  if (!meta) return;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el != null && val != null) el.value = val;
  };
  set('te-metaName', meta.name);
  set('te-metaDiff', meta.difficulty);
  if (meta.trackWidth != null) set('te-metaWidth', meta.trackWidth);
  if (meta.laps != null) set('te-metaLaps', meta.laps);
  if (meta.targetLap != null) set('te-metaTarget', meta.targetLap);
  if (meta.startPos) {
    set('te-startX', meta.startPos.x);
    set('te-startY', meta.startPos.y);
  }
  if (meta.startAngle != null) set('te-startAngle', meta.startAngle);
  if (meta.cpFracs) set('te-cpFracs', meta.cpFracs.join(', '));
  if (meta.drsFracs) set('te-drsFracs', meta.drsFracs.map(p => p[0] + '-' + p[1]).join('; '));
  if (meta.pitLane && meta.pitLane.path) {
    state.pitPath = meta.pitLane.path.map(p => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
    set('te-pitPath', JSON.stringify(state.pitPath));
  }
  if (meta.pitLane && meta.pitLane.width != null) set('te-pitWidth', meta.pitLane.width);
  const hwEl = document.getElementById('te-sfGateHalfWidth');
  if (hwEl) {
    hwEl.value = (meta.sfGateHalfWidth != null && isFinite(meta.sfGateHalfWidth) && meta.sfGateHalfWidth > 0)
      ? meta.sfGateHalfWidth : '';
  }
}

function getProject() {
  return {
    version: 1,
    type: 'kartblitz-track-editor',
    closed: state.closed,
    waypoints: clonePts(state.waypoints),
    racingLine: clonePts(state.racingLine),
    meta: readMetaFromForm()
  };
}

function autosave() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(getProject())); } catch (e) {}
}

// ── Camera / coords ─────────────────────────────────────────────────────────
function resize() {
  if (!canvas || !ctx) return false;
  const wrap = canvas.parentElement;
  if (!wrap) return false;
  let w = Math.max(0, Math.floor(wrap.clientWidth));
  let h = Math.max(0, Math.floor(wrap.clientHeight));
  // Fallback when grid hasn't laid out yet (common right after opening editor)
  if (w < 48 || h < 48) {
    w = Math.max(320, Math.floor(window.innerWidth - 400));
    h = Math.max(240, Math.floor(window.innerHeight - 90));
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return w >= 48 && h >= 48;
}
function fitEditorView(forceCenter) {
  let tries = 0;
  const run = () => {
    const ok = resize();
    if (!ok && tries++ < 25) {
      requestAnimationFrame(run);
      return;
    }
    if (forceCenter !== false) centerView();
    syncUI();
    render();
  };
  run();
}
function screenToWorld(sx, sy) {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  return {
    x: state.cam.x + (sx - w / 2) / state.cam.zoom,
    y: state.cam.y + (sy - h / 2) / state.cam.zoom
  };
}
function worldToScreen(wx, wy) {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  return {
    x: (wx - state.cam.x) * state.cam.zoom + w / 2,
    y: (wy - state.cam.y) * state.cam.zoom + h / 2
  };
}
function snapPt(p) {
  if (!state.snap) return p;
  const g = state.gridSize || 100;
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
}
function centerView() {
  if (!state.waypoints.length) {
    state.cam.x = 2600;
    state.cam.y = 3200;
    state.cam.zoom = 0.18;
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of state.waypoints) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  // Include racing line / start in the fit box when present
  for (const p of state.racingLine) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  for (const p of state.pitPath) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  state.cam.x = (minX + maxX) / 2;
  state.cam.y = (minY + maxY) / 2;
  const pad = 180;
  const spanX = Math.max(400, maxX - minX + pad * 2);
  const spanY = Math.max(400, maxY - minY + pad * 2);
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.max(1, canvas.clientWidth || Math.floor(canvas.width / dpr) || 800);
  const h = Math.max(1, canvas.clientHeight || Math.floor(canvas.height / dpr) || 600);
  const zx = w / spanX;
  const zy = h / spanY;
  // Fit whole circuit with a little margin; avoid extreme zooms
  state.cam.zoom = Math.max(0.03, Math.min(1.2, Math.min(zx, zy) * 0.9));
}
function hitNode(world, radiusWorld) {
  const pts = activePts();
  let best = -1, bestD = radiusWorld;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - world.x, pts[i].y - world.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
function nearestSegment(world) {
  const pts = activePts();
  const n = pts.length;
  if (n < 2) return null;
  let best = null, bestD = Infinity;
  const closedLayer = state.editLayer === 'waypoints' ? state.closed : false;
  const segs = closedLayer ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = distToSeg(world.x, world.y, a.x, a.y, b.x, b.y);
    if (d < bestD) {
      bestD = d;
      const dx = b.x - a.x, dy = b.y - a.y, lenSq = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((world.x - a.x) * dx + (world.y - a.y) * dy) / lenSq));
      best = { idx: i, t, point: { x: a.x + dx * t, y: a.y + dy * t }, dist: d };
    }
  }
  return best;
}

function getSfGateGeom() {
  if (state.waypoints.length < 2) return null;
  const meta = readMetaFromForm();
  const spline = buildSpline(state.waypoints, 28);
  if (!spline || spline.length < 2) return null;
  const cum = buildCum(spline);
  const total = cum[cum.length - 1] || 1;
  const frac = (meta.cpFracs && meta.cpFracs.length) ? (((meta.cpFracs[0] % 1) + 1) % 1) : 0;
  const i = fracToSplineIndex(cum, frac);
  const p = spline[Math.min(i, spline.length - 1)];
  const tan = splineTangent(spline, i);
  const perp = { x: -tan.y, y: tan.x };
  const tw = meta.trackWidth || 120;
  const hw = (meta.sfGateHalfWidth != null && meta.sfGateHalfWidth > 0)
    ? meta.sfGateHalfWidth
    : tw * 0.7;
  return {
    cx: p.x, cy: p.y, tan, perp, hw, frac, idx: i, total,
    e1: { x: p.x + perp.x * hw, y: p.y + perp.y * hw },
    e2: { x: p.x - perp.x * hw, y: p.y - perp.y * hw }
  };
}

function projectWorldOntoSpline(world) {
  if (state.waypoints.length < 2) return null;
  const spline = buildSpline(state.waypoints, 28);
  if (!spline || spline.length < 2) return null;
  const cum = buildCum(spline);
  const total = cum[cum.length - 1] || 1;
  let best = null;
  for (let i = 0; i < spline.length; i++) {
    const d = Math.hypot(world.x - spline[i].x, world.y - spline[i].y);
    if (!best || d < best.d) best = { i, d };
  }
  const tan = splineTangent(spline, best.i);
  const frac = Math.max(0, Math.min(0.9999, (cum[best.i] || 0) / total));
  return {
    frac,
    point: { x: spline[best.i].x, y: spline[best.i].y },
    tan,
    angle: Math.atan2(tan.y, tan.x)
  };
}

function setCpFrac0(frac) {
  const el = document.getElementById('te-cpFracs');
  const parts = String(el ? el.value : '0').split(/[, ]+/).map(s => s.trim()).filter(Boolean);
  const rest = parts.slice(1);
  const f = Math.max(0, Math.min(0.9999, Number(frac) || 0));
  const next = [String(Math.round(f * 10000) / 10000)].concat(rest.length ? rest : []);
  if (el) el.value = next.join(', ');
}

function setSfGateHalfWidth(hw) {
  const el = document.getElementById('te-sfGateHalfWidth');
  if (el) el.value = Math.round(hw);
}

function setStartFromPoint(point, angle) {
  const sx = document.getElementById('te-startX');
  const sy = document.getElementById('te-startY');
  const sa = document.getElementById('te-startAngle');
  if (sx) sx.value = Math.round(point.x);
  if (sy) sy.value = Math.round(point.y);
  if (sa && angle != null) sa.value = Math.round(angle * 1000) / 1000;
}

function hitSfHandle(world, radiusWorld) {
  const g = getSfGateGeom();
  if (!g) return null;
  const d0 = Math.hypot(world.x - g.cx, world.y - g.cy);
  const d1 = Math.hypot(world.x - g.e1.x, world.y - g.e1.y);
  const d2 = Math.hypot(world.x - g.e2.x, world.y - g.e2.y);
  if (d1 <= radiusWorld || d2 <= radiusWorld) {
    if (d1 <= d2 && d1 <= radiusWorld) return { type: 'gateEnd', end: 1, geom: g };
    if (d2 <= radiusWorld) return { type: 'gateEnd', end: 2, geom: g };
  }
  if (d0 <= radiusWorld * 1.35) return { type: 'sf', geom: g };
  return null;
}

// ── Rendering ───────────────────────────────────────────────────────────────
function drawPoly(pts, closePath) {
  if (!pts.length) return;
  ctx.beginPath();
  const s0 = worldToScreen(pts[0].x, pts[0].y);
  ctx.moveTo(s0.x, s0.y);
  for (let i = 1; i < pts.length; i++) {
    const s = worldToScreen(pts[i].x, pts[i].y);
    ctx.lineTo(s.x, s.y);
  }
  if (closePath && pts.length > 2) ctx.closePath();
}

function render() {
  if (!_open || !canvas || !ctx) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#080c12';
  ctx.fillRect(0, 0, w, h);

  if (state.showGrid) drawGrid();

  const meta = readMetaFromForm();
  const widthPx = Math.max(4, (meta.trackWidth || 120) * state.cam.zoom * 0.35);

  // Remapped preview (optional)
  let previewWps = state.waypoints;
  if (state.showRemap && state.waypoints.length >= 3) {
    previewWps = remapTrackWaypointsForBraking(state.waypoints, getTrackRemapProfile(meta));
  }

  const spline = (state.showRace || state.showCp || state.showDir) && previewWps.length >= 2
    ? buildSpline(previewWps, 28) : [];

  // Track ribbon (racing line width)
  if (state.showRace && spline.length > 2) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = Math.max(8, (meta.trackWidth || 120) * state.cam.zoom);
    drawPoly(spline, true); ctx.stroke();
    ctx.strokeStyle = '#ff950088';
    ctx.lineWidth = Math.max(10, (meta.trackWidth || 120) * state.cam.zoom + 4);
    drawPoly(spline, true); ctx.stroke();
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = Math.max(6, (meta.trackWidth || 120) * state.cam.zoom - 2);
    drawPoly(spline, true); ctx.stroke();
    ctx.strokeStyle = '#ffffff55';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 10]);
    drawPoly(spline, true); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Authored polyline
  if (state.showLine && state.waypoints.length) {
    ctx.strokeStyle = '#3dd6c6';
    ctx.lineWidth = 2;
    drawPoly(state.waypoints, state.closed);
    ctx.stroke();
  }

  // Authored AI racing line — Catmull-Rom curve through nodes (same as track centreline)
  if (state.showAILine && state.racingLine.length >= 2) {
    const rlCurve = state.racingLine.length >= 3
      ? buildSpline(state.racingLine, 28)
      : state.racingLine;
    ctx.strokeStyle = '#e879f9';
    ctx.lineWidth = state.editLayer === 'racingLine' ? 3 : 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(state.editLayer === 'racingLine' ? [] : [10, 6]);
    drawPoly(rlCurve, true);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Pit path
  const pitPts = (state.pitPath && state.pitPath.length)
    ? state.pitPath
    : ((meta.pitLane && meta.pitLane.path) || []);
  if (state.showPit && pitPts.length) {
    ctx.strokeStyle = state.editLayer === 'pitPath' ? '#fbbf24' : '#f59e0b';
    ctx.lineWidth = state.editLayer === 'pitPath' ? 3 : 2;
    ctx.setLineDash(state.editLayer === 'pitPath' ? [] : [6, 4]);
    drawPoly(pitPts, false);
    ctx.stroke();
    ctx.setLineDash([]);
    const entry = pitPts[0];
    const exit = pitPts[pitPts.length - 1];
    const garage = pitPts[Math.floor(pitPts.length / 2)];
    for (const [p, label] of [[entry, 'entry'], [garage, 'garage'], [exit, 'exit']]) {
      if (!p) continue;
      const s = worldToScreen(p.x, p.y);
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fbbf24';
      ctx.font = '10px sans-serif';
      ctx.fillText(label, s.x + 6, s.y - 6);
    }
  }

  // CP / DRS markers on spline
  if (state.showCp && spline.length > 2) {
    const cum = buildCum(spline);
    const total = cum[cum.length - 1] || 1;
    for (const [a, b] of (meta.drsFracs || [])) {
      const i0 = fracToSplineIndex(cum, a);
      let i1 = fracToSplineIndex(cum, b);
      if (i1 < i0) i1 += spline.length;
      ctx.strokeStyle = '#3b82f688';
      ctx.lineWidth = Math.max(6, widthPx * 0.8);
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const p = spline[i % spline.length];
        const s = worldToScreen(p.x, p.y);
        if (i === i0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
    }
    (meta.cpFracs || []).forEach((f, idx) => {
      if (idx === 0) return; // S/F drawn with draggable gate below
      const i = fracToSplineIndex(cum, f);
      const p = spline[Math.min(i, spline.length - 1)];
      const tan = splineTangent(spline, i);
      const s = worldToScreen(p.x, p.y);
      const nx = -tan.y * 18, ny = tan.x * 18;
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x - nx, s.y - ny);
      ctx.lineTo(s.x + nx, s.y + ny);
      ctx.stroke();
      ctx.fillStyle = '#93c5fd';
      ctx.font = '10px sans-serif';
      ctx.fillText('CP' + idx, s.x + 8, s.y - 8);
    });
  }

  // Draggable S/F + checkered gate length handles
  {
    const g = getSfGateGeom();
    if (g) {
      const s1 = worldToScreen(g.e1.x, g.e1.y);
      const s2 = worldToScreen(g.e2.x, g.e2.y);
      const sc = worldToScreen(g.cx, g.cy);
      // Checkered preview strip
      const ang = Math.atan2(g.e2.y - g.e1.y, g.e2.x - g.e1.x);
      const sfW = Math.hypot(s2.x - s1.x, s2.y - s1.y);
      ctx.save();
      ctx.translate(sc.x, sc.y);
      ctx.rotate(ang);
      const sq = 6;
      for (let ci = 0; ci < sfW / sq + 1; ci++) {
        for (let ri = 0; ri < 3; ri++) {
          ctx.fillStyle = (ci + ri) % 2 === 0 ? '#ffffff' : '#111111';
          ctx.fillRect(ci * sq - sfW / 2, ri * sq - sq * 1.5, sq, sq);
        }
      }
      ctx.restore();
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(s2.x, s2.y);
      ctx.stroke();
      // Center drag handle
      ctx.fillStyle = '#22c55e';
      ctx.beginPath(); ctx.arc(sc.x, sc.y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#052e16';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#86efac';
      ctx.font = '11px sans-serif';
      ctx.fillText('S/F', sc.x + 10, sc.y - 10);
      // End handles for gate length
      for (const s of [s1, s2]) {
        ctx.fillStyle = '#fde047';
        ctx.fillRect(s.x - 6, s.y - 6, 12, 12);
        ctx.strokeStyle = '#854d0e';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(s.x - 6, s.y - 6, 12, 12);
      }
    }
  }

  // Direction arrows on racing line
  if (state.showDir && spline.length > 20) {
    ctx.fillStyle = '#3dd6c6aa';
    for (let i = 0; i < spline.length; i += Math.max(12, Math.floor(spline.length / 24))) {
      const p = spline[i], tan = splineTangent(spline, i);
      const s = worldToScreen(p.x, p.y);
      const ang = Math.atan2(tan.y, tan.x);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(10, 0); ctx.lineTo(-6, -5); ctx.lineTo(-6, 5);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  // Start marker
  {
    const sp = meta.startPos;
    const s = worldToScreen(sp.x, sp.y);
    const ang = meta.startAngle || 0;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(ang);
    ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -8); ctx.lineTo(-8, 8); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#86efac';
    ctx.font = '11px sans-serif';
    ctx.fillText('START', s.x + 10, s.y - 10);
  }

  // Nodes (active edit layer)
  if (state.showNodes) {
    const pts = activePts();
    const isRL = state.editLayer === 'racingLine';
    const isPit = state.editLayer === 'pitPath';
    pts.forEach((p, i) => {
      const s = worldToScreen(p.x, p.y);
      const sel = state.selected.has(i);
      const brake = (!isRL && !isPit) ? normalizeBrakeTag(p.brake) : 0;
      ctx.beginPath();
      ctx.arc(s.x, s.y, sel ? 8 : 6, 0, Math.PI * 2);
      if (sel) ctx.fillStyle = '#ff9500';
      else if (isRL) ctx.fillStyle = '#e879f9';
      else if (isPit) ctx.fillStyle = i === 0 ? '#f59e0b' : '#fbbf24';
      else if (brake >= 5) ctx.fillStyle = '#7f1d1d';
      else if (brake >= 4) ctx.fillStyle = '#dc2626';
      else if (brake >= 3) ctx.fillStyle = '#ef4444';
      else if (brake >= 2) ctx.fillStyle = '#f97316';
      else if (brake >= 1) ctx.fillStyle = '#f59e0b';
      else ctx.fillStyle = i === 0 ? '#22c55e' : '#e8eef6';
      ctx.fill();
      ctx.strokeStyle = '#0c1118';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = isRL ? '#f0abfc' : (isPit ? '#fde68a' : (brake ? '#fecaca' : '#8fa3b8'));
      ctx.font = '10px Consolas, monospace';
      const label = isRL ? ('R' + i) : (isPit ? ('P' + i) : (brake ? (i + ':' + brake) : String(i)));
      ctx.fillText(label, s.x + 9, s.y - 9);
    });
  }

  // Selection box
  if (state.box) {
    const a = state.box.a, b = state.box.b;
    ctx.strokeStyle = '#3dd6c688';
    ctx.fillStyle = '#3dd6c622';
    ctx.lineWidth = 1;
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  }

  updateStatus();
}

function drawGrid() {
  const g = state.gridSize || 100;
  const tl = screenToWorld(0, 0), br = screenToWorld(canvas.clientWidth, canvas.clientHeight);
  const x0 = Math.floor(tl.x / g) * g, y0 = Math.floor(tl.y / g) * g;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= br.x + g; x += g) {
    const s1 = worldToScreen(x, tl.y), s2 = worldToScreen(x, br.y);
    ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
  }
  for (let y = y0; y <= br.y + g; y += g) {
    const s1 = worldToScreen(tl.x, y), s2 = worldToScreen(br.x, y);
    ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y);
  }
  ctx.stroke();
}

function updateStatus() {
  const c = state.cursorWorld;
  document.getElementById('te-stCursor').textContent = c ? `${Math.round(c.x)}, ${Math.round(c.y)}` : '—';
  const pts = activePts();
  const sel = [...state.selected];
  if (sel.length === 1 && pts[sel[0]]) {
    const p = pts[sel[0]];
    document.getElementById('te-stSel').textContent = `#${sel[0]} (${Math.round(p.x)}, ${Math.round(p.y)})`;
  } else if (sel.length > 1) {
    document.getElementById('te-stSel').textContent = `${sel.length} nodes`;
  } else {
    document.getElementById('te-stSel').textContent = '—';
  }
  document.getElementById('te-stNodes').textContent = String(state.waypoints.length);
  document.getElementById('te-nodeCountPill').textContent =
    state.waypoints.length + ' track · ' + state.racingLine.length + 'AI · ' + state.pitPath.length + ' pit';
  document.getElementById('te-stZoom').textContent = Math.round(state.cam.zoom * 100) + '%';
  document.getElementById('te-stLoop').textContent = state.closed ? 'closed' : 'open';
  const rlEl = document.getElementById('te-rlInfo');
  if (rlEl) {
    rlEl.textContent = state.racingLine.length >= 3
      ? `AI line: ${state.racingLine.length} nodes (exported with track)`
      : 'No AI racing line (AI uses default centreline behaviour)';
  }
}

function setMsg(t) {
  document.getElementById('te-stMsg').textContent = t || '';
  if (t) setTimeout(() => { if (document.getElementById('te-stMsg').textContent === t) document.getElementById('te-stMsg').textContent = ''; }, 2500);
}

function syncUI() {
  const pts = activePts();
  const sel = [...state.selected];
  const layerLabel = state.editLayer === 'racingLine' ? 'AI line'
    : (state.editLayer === 'pitPath' ? 'Pit' : 'Track');
  if (sel.length === 1 && pts[sel[0]]) {
    const p = pts[sel[0]];
    const brakeTxt = state.editLayer === 'waypoints' ? ` · brake ${normalizeBrakeTag(p.brake)}` : '';
    document.getElementById('te-selInfo').textContent = `${layerLabel} node #${sel[0]}${brakeTxt}`;
    document.getElementById('te-inpIdx').value = sel[0];
    document.getElementById('te-inpX').value = Math.round(p.x * 100) / 100;
    document.getElementById('te-inpY').value = Math.round(p.y * 100) / 100;
  } else {
    document.getElementById('te-selInfo').textContent = sel.length ? `${sel.length} selected (${layerLabel})` : `None selected · editing ${layerLabel}`;
    document.getElementById('te-inpIdx').value = '';
    document.getElementById('te-inpX').value = '';
    document.getElementById('te-inpY').value = '';
  }
  const brakeInfo = document.getElementById('te-brakeInfo');
  if (brakeInfo) {
    if (state.editLayer !== 'waypoints') {
      brakeInfo.textContent = 'Switch to Track layer to tag brake points';
    } else if (!sel.length) {
      brakeInfo.textContent = 'Select track node(s) to set brake tags';
    } else if (sel.length === 1 && state.waypoints[sel[0]]) {
      brakeInfo.textContent = `Node #${sel[0]} brake = ${normalizeBrakeTag(state.waypoints[sel[0]].brake)}`;
    } else {
      brakeInfo.textContent = `${sel.length} nodes selected — click Brake 0–5`;
    }
  }
  document.getElementById('te-btnCloseLoop').classList.toggle('active', state.closed);
  updateStatus();
}

// ── Editing ─────────────────────────────────────────────────────────────────
function setTool(tool) {
  state.tool = tool;
  root.querySelectorAll('#te-toolbar [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
}

function deleteSelected() {
  if (!state.selected.size) return;
  pushUndo();
  const kill = new Set(state.selected);
  if (state.editLayer === 'racingLine') {
    state.racingLine = state.racingLine.filter((_, i) => !kill.has(i));
  } else if (state.editLayer === 'pitPath') {
    state.pitPath = state.pitPath.filter((_, i) => !kill.has(i));
    syncPitPathToForm();
  } else {
    state.waypoints = state.waypoints.filter((_, i) => !kill.has(i));
  }
  state.selected.clear();
  syncUI(); render(); autosave();
}

function addNodeAt(world) {
  pushUndo();
  const p = snapPt(world);
  if (state.editLayer === 'waypoints') p.brake = 0;
  const pts = activePts();
  pts.push(p);
  state.selected = new Set([pts.length - 1]);
  if (state.editLayer === 'pitPath') syncPitPathToForm();
  syncUI(); render(); autosave();
}

function insertNodeAt(world) {
  const seg = nearestSegment(world);
  if (!seg || seg.dist > 80 / state.cam.zoom) {
    setMsg('Move closer to a segment to insert');
    return;
  }
  pushUndo();
  const p = snapPt(seg.point);
  if (state.editLayer === 'waypoints') p.brake = 0;
  const pts = activePts();
  pts.splice(seg.idx + 1, 0, p);
  state.selected = new Set([seg.idx + 1]);
  if (state.editLayer === 'pitPath') syncPitPathToForm();
  syncUI(); render(); autosave();
}

function setSelectedBrake(tag) {
  if (state.editLayer !== 'waypoints') {
    setMsg('Switch to Track layer to set brake tags');
    return;
  }
  if (!state.selected.size) {
    setMsg('Select one or more track nodes first');
    return;
  }
  pushUndo();
  const b = normalizeBrakeTag(tag);
  for (const i of state.selected) {
    if (state.waypoints[i]) state.waypoints[i].brake = b;
  }
  syncUI(); render(); autosave();
  setMsg(`Set brake ${b} on ${state.selected.size} node(s)`);
}

// ── Pointer events ──────────────────────────────────────────────────────────
function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

if (canvas) {
canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('wheel', e => {
  if (!_open) return;
  e.preventDefault();
  const sp = canvasPos(e);
  const before = screenToWorld(sp.x, sp.y);
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  state.cam.zoom = Math.max(0.04, Math.min(4, state.cam.zoom * factor));
  const after = screenToWorld(sp.x, sp.y);
  state.cam.x += before.x - after.x;
  state.cam.y += before.y - after.y;
  render();
}, { passive: false });

canvas.addEventListener('pointerdown', e => {
  if (!_open) return;
  canvas.setPointerCapture(e.pointerId);
  const sp = canvasPos(e);
  const world = screenToWorld(sp.x, sp.y);
  state.cursorWorld = world;

  if (e.button === 1 || e.button === 2 || state.spaceDown) {
    state.pan = { sx: sp.x, sy: sp.y, cx: state.cam.x, cy: state.cam.y };
    return;
  }

  if (state.tool === 'add') { addNodeAt(world); return; }
  if (state.tool === 'insert') { insertNodeAt(world); return; }

  const hitR = 12 / state.cam.zoom;

  // Prefer S/F / gate handles over nodes when select/move
  if (state.tool === 'select' || state.tool === 'move') {
    const sfHit = hitSfHandle(world, hitR * 1.4);
    if (sfHit) {
      pushUndo();
      state.selected.clear();
      state.dragging = { kind: sfHit.type, end: sfHit.end, last: world };
      syncUI(); render();
      return;
    }
  }

  const hit = hitNode(world, hitR);

  if (state.tool === 'delete') {
    if (hit >= 0) {
      state.selected = new Set([hit]);
      deleteSelected();
    }
    return;
  }

  if (hit >= 0) {
    if (e.shiftKey) {
      if (state.selected.has(hit)) state.selected.delete(hit);
      else state.selected.add(hit);
    } else if (!state.selected.has(hit)) {
      state.selected = new Set([hit]);
    }
    if (state.tool === 'select' || state.tool === 'move') {
      pushUndo();
      state.dragging = {
        kind: 'nodes',
        last: world,
        indices: [...state.selected]
      };
    }
    syncUI(); render();
    return;
  }

  if (!e.shiftKey) state.selected.clear();
  if (state.tool === 'select') {
    state.box = { a: sp, b: sp };
  }
  syncUI(); render();
});

canvas.addEventListener('pointermove', e => {
  if (!_open) return;
  const sp = canvasPos(e);
  const world = screenToWorld(sp.x, sp.y);
  state.cursorWorld = world;
  updateStatus();

  if (state.pan) {
    state.cam.x = state.pan.cx - (sp.x - state.pan.sx) / state.cam.zoom;
    state.cam.y = state.pan.cy - (sp.y - state.pan.sy) / state.cam.zoom;
    render();
    return;
  }

  if (state.dragging) {
    if (state.dragging.kind === 'sf') {
      const proj = projectWorldOntoSpline(world);
      if (proj) {
        setCpFrac0(proj.frac);
        setStartFromPoint(proj.point, proj.angle);
      }
      state.dragging.last = world;
      syncUI(); render();
      return;
    }
    if (state.dragging.kind === 'gateEnd') {
      const g = getSfGateGeom();
      if (g) {
        const meta = readMetaFromForm();
        const tw = meta.trackWidth || 120;
        const minHw = tw * 0.4;
        const dist = Math.hypot(world.x - g.cx, world.y - g.cy);
        setSfGateHalfWidth(Math.max(minHw, dist));
      }
      state.dragging.last = world;
      syncUI(); render();
      return;
    }
    const pts = activePts();
    let dx = world.x - state.dragging.last.x;
    let dy = world.y - state.dragging.last.y;
    if (state.snap) {
      const primary = state.dragging.indices[0];
      if (primary != null && pts[primary]) {
        const p = pts[primary];
        const snapped = snapPt({ x: p.x + dx, y: p.y + dy });
        dx = snapped.x - p.x;
        dy = snapped.y - p.y;
      }
    }
    for (const i of state.dragging.indices) {
      if (!pts[i]) continue;
      pts[i].x += dx;
      pts[i].y += dy;
    }
    state.dragging.last = world;
    if (state.editLayer === 'pitPath') syncPitPathToForm();
    syncUI(); render();
    return;
  }

  if (state.box) {
    state.box.b = sp;
    render();
  }
});

canvas.addEventListener('pointerup', e => {
  if (state.pan) { state.pan = null; return; }
  if (state.dragging) {
    if (state.editLayer === 'pitPath' || state.dragging.kind === 'sf' || state.dragging.kind === 'gateEnd') {
      syncPitPathToForm();
    }
    state.dragging = null;
    autosave();
    return;
  }
  if (state.box) {
    const a = state.box.a, b = state.box.b;
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    if (Math.hypot(maxX - minX, maxY - minY) > 4) {
      if (!e.shiftKey) state.selected.clear();
      activePts().forEach((p, i) => {
        const s = worldToScreen(p.x, p.y);
        if (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY) state.selected.add(i);
      });
    }
    state.box = null;
    syncUI(); render();
  }
});

canvas.addEventListener('pointerleave', () => {
  state.cursorWorld = null;
  updateStatus();
});
} // end if (canvas)

// ── Keyboard ────────────────────────────────────────────────────────────────
try {
window.addEventListener('keydown', e => {
  if (!api.isOpen()) return;
  if (e.target.matches('input, textarea, select')) return;
  if (e.code === 'Space') { state.spaceDown = true; e.preventDefault(); }
  if (e.key === 'v' || e.key === 'V') setTool('select');
  if (e.key === 'g' || e.key === 'G') setTool('move');
  if (e.key === 'a' || e.key === 'A') setTool('add');
  if (e.key === 'i' || e.key === 'I') setTool('insert');
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  if (e.key === '0') setSelectedBrake(0);
  if (e.key === '1') setSelectedBrake(1);
  if (e.key === '2') setSelectedBrake(2);
  if (e.key === '3') setSelectedBrake(3);
  if (e.key === '4') setSelectedBrake(4);
  if (e.key === '5') setSelectedBrake(5);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault(); redo();
  }
});
window.addEventListener('keyup', e => {
  if (!api.isOpen()) return;
  if (e.code === 'Space') state.spaceDown = false;
});

// ── Toolbar / form bindings ─────────────────────────────────────────────────
if (root) root.querySelectorAll('#te-toolbar [data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});
const _teBind = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
_teBind('te-btnUndo', undo);
_teBind('te-btnRedo', redo);
_teBind('te-btnCenter', () => { fitEditorView(true); });
_teBind('te-btnResetCam', () => {
  state.cam = { x: 2600, y: 3200, zoom: 0.18 };
  fitEditorView(false);
});
_teBind('te-btnCloseLoop', () => {
  pushUndo();
  state.closed = !state.closed;
  syncUI(); render(); autosave();
});
_teBind('te-btnApplyXY', () => {
  const sel = [...state.selected];
  const pts = activePts();
  if (sel.length !== 1 || !pts[sel[0]]) return;
  pushUndo();
  pts[sel[0]].x = Number(document.getElementById('te-inpX').value);
  pts[sel[0]].y = Number(document.getElementById('te-inpY').value);
  if (state.editLayer === 'pitPath') syncPitPathToForm();
  syncUI(); render(); autosave();
});
_teBind('te-btnBrake0', () => setSelectedBrake(0));
_teBind('te-btnBrake1', () => setSelectedBrake(1));
_teBind('te-btnBrake2', () => setSelectedBrake(2));
_teBind('te-btnBrake3', () => setSelectedBrake(3));
_teBind('te-btnBrake4', () => setSelectedBrake(4));
_teBind('te-btnBrake5', () => setSelectedBrake(5));
_teBind('te-btnDeleteSel', deleteSelected);

_teBind('te-btnLayerTrack', () => setEditLayer('waypoints'));
_teBind('te-btnLayerAI', () => setEditLayer('racingLine'));
_teBind('te-btnLayerPit', () => setEditLayer('pitPath'));
_teBind('te-btnCopyRL', () => {
  if (state.waypoints.length < 3) { setMsg('Need track waypoints first'); return; }
  pushUndo();
  state.racingLine = clonePts(state.waypoints);
  setEditLayer('racingLine');
  setMsg('Racing line copied from centerline — nudge apexes inward');
  autosave();
});
_teBind('te-btnClearRL', () => {
  pushUndo();
  state.racingLine = [];
  if (state.editLayer === 'racingLine') setEditLayer('waypoints');
  else { syncUI(); render(); }
  autosave();
  setMsg('AI racing line cleared');
});

['togGrid','togSnap','togNodes','togLine','togRace','togAILine','togRemap','togPit','togDir','togCp'].forEach(id => {
  const el = document.getElementById('te-' + id);
  if (!el) return;
  el.addEventListener('change', e => {
    const map = {
      togGrid: 'showGrid', togSnap: 'snap', togNodes: 'showNodes', togLine: 'showLine',
      togRace: 'showRace', togAILine: 'showAILine', togRemap: 'showRemap', togPit: 'showPit',
      togDir: 'showDir', togCp: 'showCp'
    };
    state[map[id]] = e.target.checked;
    if (id === 'togSnap') state.snap = e.target.checked;
    render();
  });
});
const _teInpGrid = document.getElementById('te-inpGrid');
if (_teInpGrid) _teInpGrid.addEventListener('change', e => {
  state.gridSize = Math.max(10, Number(e.target.value) || 100);
  render();
});
['te-metaName','te-metaDiff','te-metaWidth','te-metaLaps','te-metaTarget','te-startX','te-startY','te-startAngle','te-cpFracs','te-drsFracs','te-pitPath','te-pitWidth','te-sfGateHalfWidth'].forEach(fid => {
  const el = document.getElementById(fid);
  if (!el) return;
  el.addEventListener('change', () => {
    if (fid === 'te-pitPath') loadPitPathFromForm();
    render(); autosave();
  });
});
} catch (bindErr) {
  console.error('Track editor control bindings failed:', bindErr);
}

// ── Import / Export ─────────────────────────────────────────────────────────
function parseCoordinateText(text) {
  text = (text || '').trim();
  if (!text) throw new Error('Empty input');

  // Try JSON first (allow unquoted keys lightly)
  let jsonTry = text;
  if (!/^\s*[\[{]/.test(text) && /x\s*:/.test(text)) {
    jsonTry = '[' + text.replace(/^\s*waypoints\s*[:=]\s*/i, '') + ']';
  }
  // Convert JS-ish {x:1,y:2} to JSON
  const asJson = jsonTry
    .replace(/([{,]\s*)([a-zA-Z_][\w]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"');
  try {
    const data = JSON.parse(asJson);
    return normalizeImported(data);
  } catch (e) { /* fall through */ }

  // CSV / plain text lines
  const pts = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^x\s*[,;\s]\s*y/i.test(t)) continue;
    let m = t.match(/(-?\d+\.?\d*)\s*[,;\s]\s*(-?\d+\.?\d*)(?:\s*[,;\s]\s*(-?\d+\.?\d*))?/);
    if (!m) m = t.match(/x\s*[:=]\s*(-?\d+\.?\d*).*?y\s*[:=]\s*(-?\d+\.?\d*)(?:.*?brake\s*[:=]\s*(-?\d+\.?\d*))?/i);
    if (m) {
      const pt = { x: Number(m[1]), y: Number(m[2]), brake: 0 };
      if (m[3] != null && m[3] !== '') pt.brake = normalizeBrakeTag(m[3]);
      pts.push(pt);
    }
  }
  if (pts.length >= 2) return { waypoints: pts };
  throw new Error('Could not parse coordinates');
}

function normalizeImported(data) {
  if (Array.isArray(data)) {
    if (data.length && typeof data[0].x === 'number') return { waypoints: data };
  }
  if (data.waypoints) {
    return {
      waypoints: data.waypoints,
      racingLine: data.racingLine || (data.meta && data.meta.racingLine) || [],
      closed: data.closed !== false,
      meta: data.meta || data
    };
  }
  if (data.type === 'kartblitz-track-editor' && data.waypoints) {
    return {
      waypoints: data.waypoints,
      racingLine: data.racingLine || [],
      closed: data.closed !== false,
      meta: data.meta
    };
  }
  throw new Error('Unrecognized data shape');
}

function applyImport(parsed) {
  pushUndo();
  state.waypoints = clonePts(parsed.waypoints);
  state.racingLine = Array.isArray(parsed.racingLine) ? clonePts(parsed.racingLine) : [];
  if (parsed.closed != null) state.closed = parsed.closed;
  state.selected.clear();
  if (parsed.meta && (parsed.meta.startPos || parsed.meta.pitLane || parsed.meta.name || parsed.meta.racingLine || parsed.meta.sfGateHalfWidth != null)) {
    applyMetaToForm(parsed.meta);
    if (Array.isArray(parsed.meta.racingLine) && !parsed.racingLine) {
      state.racingLine = clonePts(parsed.meta.racingLine);
    }
  } else {
    loadPitPathFromForm();
  }
  syncUI(); fitEditorView(true); autosave();
  setMsg('Imported ' + state.waypoints.length + ' track nodes' +
    (state.racingLine.length ? ', ' + state.racingLine.length + 'AI line' : '') +
    (state.pitPath.length ? ', ' + state.pitPath.length + ' pit' : ''));
}

(function bindImportExport() {
  const importBtn = document.getElementById('te-btnImport');
  if (importBtn) importBtn.onclick = () => {
    try {
      const text = (document.getElementById('te-importArea') || {}).value || '';
      applyImport(parseCoordinateText(text));
    } catch (err) {
      setMsg('Import failed: ' + err.message);
      alert('Import failed: ' + err.message);
    }
  };
  const importFileBtn = document.getElementById('te-btnImportFile');
  const fileImport = document.getElementById('te-fileImport');
  if (importFileBtn && fileImport) {
    importFileBtn.onclick = () => fileImport.click();
    fileImport.onchange = async e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        applyImport(parseCoordinateText(await file.text()));
      } catch (err) {
        alert('Import failed: ' + err.message);
      }
    };
  }
})();

function formatWaypointsJS(wps) {
  const lines = wps.map((p, i) => {
    const comma = i < wps.length - 1 ? ',' : '';
    return `      ${formatWpJS(p)}${comma}`;
  });
  return 'waypoints:[\n' + lines.join('\n') + '\n    ]';
}

function formatTracksObject() {
  const meta = readMetaFromForm();
  const wps = state.waypoints.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), brake: normalizeBrakeTag(p.brake) }));
  const pitPath = (state.pitPath && state.pitPath.length ? state.pitPath : meta.pitLane.path);
  const pit = pitPath.map(p => `{x:${Math.round(p.x)},y:${Math.round(p.y)}}`).join(',');
  const entry = pitPath[0] || meta.startPos;
  const exit = pitPath[pitPath.length - 1] || entry;
  const garageIdx = Math.floor(pitPath.length / 2);
  const garage = pitPath[garageIdx] || entry;
  const garageAngle = pathAngleAt(pitPath, garageIdx);
  const exitAngle = pathAngleAt(pitPath, pitPath.length - 1);
  const rl = state.racingLine.length >= 3
    ? `,\n  racingLine:[\n${state.racingLine.map((p, i) => `    {x:${Math.round(p.x)},y:${Math.round(p.y)}}${i < state.racingLine.length - 1 ? ',' : ''}`).join('\n')}\n  ]`
    : '';
  const sfLine = (meta.sfGateHalfWidth != null && meta.sfGateHalfWidth > 0)
    ? `,\n  sfGateHalfWidth:${Math.round(meta.sfGateHalfWidth)}`
    : '';
  return `{
  id:${meta.id}, name:'${meta.name.replace(/'/g, "\\'")}', difficulty:'${meta.difficulty}', diffClass:'${meta.diffClass}', diffLetter:'${meta.diffLetter}',
  targetLap:${meta.targetLap}, laps:${meta.laps}, trackWidth:${meta.trackWidth}, lapDistance:0, coinMult:${meta.coinMult},
  grassColor:'${meta.grassColor}', grassColor2:'${meta.grassColor2}',
  trackColor:'${meta.trackColor}', borderColor:'${meta.borderColor}', lineColor:'${meta.lineColor}',
  accentColor:'${meta.accentColor}', bgColor:'${meta.bgColor}',
  waypoints:[
${wps.map((p, i) => `    ${formatWpJS(p)}${i < wps.length - 1 ? ',' : ''}`).join('\n')}
  ]${rl},
  startPos:{x:${Math.round(meta.startPos.x)},y:${Math.round(meta.startPos.y)}}, startAngle:${meta.startAngle},
  pitPos:{x:${Math.round(garage.x)},y:${Math.round(garage.y)}},
  pitLane:{
    path:[${pit}],
    entryPt:{x:${Math.round(entry.x)},y:${Math.round(entry.y)}},
    garagePos:{x:${Math.round(garage.x)},y:${Math.round(garage.y)}}, garageAngle:${Math.round(garageAngle * 1000) / 1000},
    exitPos:{x:${Math.round(exit.x)},y:${Math.round(exit.y)}}, exitAngle:${Math.round(exitAngle * 1000) / 1000}, width:${meta.pitLane.width}
  },
  cpFracs:[${meta.cpFracs.join(', ')}],
  drsFracs:[${meta.drsFracs.map(p => `[${p[0]}, ${p[1]}]`).join(', ')}]${sfLine},
  surface:{offTrackMult:${meta.surface.offTrackMult}, label:'${meta.surface.label}'}
}`;
}

function buildExport(fmt) {
  const wps = state.waypoints;
  if (fmt === 'tracks') return formatTracksObject();
  if (fmt === 'waypoints-js') return formatWaypointsJS(wps);
  if (fmt === 'json') return JSON.stringify(wps.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), brake: normalizeBrakeTag(p.brake) })), null, 2);
  if (fmt === 'csv') return 'x,y,brake\n' + wps.map(p => `${Math.round(p.x)},${Math.round(p.y)},${normalizeBrakeTag(p.brake)}`).join('\n');
  if (fmt === 'text') return wps.map(p => `${Math.round(p.x)} ${Math.round(p.y)} ${normalizeBrakeTag(p.brake)}`).join('\n');
  return '';
}

function refreshExport() {
  document.getElementById('te-exportArea').value = buildExport(document.getElementById('te-exportFmt').value);
}
document.getElementById('te-exportFmt').onchange = refreshExport;
document.getElementById('te-btnCopy').onclick = async () => {
  refreshExport();
  const text = document.getElementById('te-exportArea').value;
  try {
    await navigator.clipboard.writeText(text);
    setMsg('Copied to clipboard');
  } catch (e) {
    document.getElementById('te-exportArea').select();
    document.execCommand('copy');
    setMsg('Copied');
  }
};
document.getElementById('te-btnDownload').onclick = () => {
  refreshExport();
  const fmt = document.getElementById('te-exportFmt').value;
  const ext = { tracks: 'js', 'waypoints-js': 'js', json: 'json', csv: 'csv', text: 'txt' }[fmt] || 'txt';
  const blob = new Blob([document.getElementById('te-exportArea').value], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (document.getElementById('te-metaName').value || 'track').replace(/\s+/g, '_').toLowerCase() + '.' + ext;
  a.click();
  URL.revokeObjectURL(a.href);
  setMsg('Download started');
};

// ── Project save / load ─────────────────────────────────────────────────────
document.getElementById('te-btnSaveProj').onclick = () => {
  const blob = new Blob([JSON.stringify(getProject(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (document.getElementById('te-metaName').value || 'track').replace(/\s+/g, '_').toLowerCase() + '.kbtrack.json';
  a.click();
  URL.revokeObjectURL(a.href);
  autosave();
  setMsg('Project saved');
};
document.getElementById('te-btnLoadProj').onclick = () => document.getElementById('te-fileProject').click();
document.getElementById('te-fileProject').onchange = async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    loadProject(data.type === 'kartblitz-track-editor' ? data : {
      waypoints: data.waypoints || data,
      racingLine: data.racingLine || (data.meta && data.meta.racingLine) || [],
      closed: data.closed !== false,
      meta: data.meta || data
    });
    autosave();
  } catch (err) {
    alert('Load failed: ' + err.message);
  }
};
document.getElementById('te-btnNew').onclick = () => {
  if (!confirm('Clear the current track and start a new template?')) return;
  pushUndo();
  _editIndex = null;
  const d = defaultProject();
  const used = new Set(TRACKS.map(t => t.id));
  let nid = 0;
  while (used.has(nid)) nid++;
  d.meta.id = nid;
  d.meta.name = 'NEW CIRCUIT ' + nid;
  state.waypoints = clonePts(d.waypoints);
  state.racingLine = clonePts(d.racingLine || []);
  state.pitPath = clonePts((d.meta.pitLane && d.meta.pitLane.path) || []);
  state.closed = true;
  state.selected.clear();
  applyMetaToForm(d.meta);
  syncUI(); fitEditorView(true); autosave();
  setMsg('New template — Apply to add to game');
};

// ── Boot (controlled by outer API — no autosave restore into live game) ─────
state.snap = !!(document.getElementById('te-togSnap') && document.getElementById('te-togSnap').checked);

  // Override readMetaFromForm id from edit target
  const _origReadMeta = readMetaFromForm;
  readMetaFromForm = function() {
    const m = _origReadMeta();
    if (_editIndex != null && TRACKS[_editIndex]) m.id = TRACKS[_editIndex].id;
    return m;
  };

  function boot() {
    try {
      bindPassUi();
      ensureBound();
      state.snap = !!(document.getElementById('te-togSnap') && document.getElementById('te-togSnap').checked);
      const d = defaultProject();
      state.waypoints = clonePts(d.waypoints);
      state.racingLine = clonePts(d.racingLine || []);
      state.pitPath = clonePts((d.meta.pitLane && d.meta.pitLane.path) || []);
      applyMetaToForm(d.meta);
      window.addEventListener('resize', () => { if (_open) fitEditorView(false); });
    } catch (err) {
      console.error('Track editor boot failed:', err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  api.isUiActive = function() {
    const ed = document.getElementById('screen-te-editor');
    const pk = document.getElementById('screen-te-picker');
    const pm = document.getElementById('te-pass-modal');
    return !!(
      (ed && ed.classList.contains('open')) ||
      (pk && pk.classList.contains('open')) ||
      (pm && pm.classList.contains('open'))
    );
  };
  api.applyToGame = applyToGame;
  api.closeAll = closeAll;
  return api;
