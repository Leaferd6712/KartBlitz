/**
 * KartBlitz player save system — versioned, monotonic, recoverable.
 * Pure logic (no DOM). Wired from index.html via window.KartBlitzSave.
 *
 * Conflict authority order:
 *   1) schema migration
 *   2) monotonic revision (+ lastSyncedRevision divergence check)
 *   3) progress fingerprint / richness (legacy-only or equal-revision ties)
 *   4) updatedAt is advisory ONLY — never sole winner
 */

export const PLAYER_SAVE_KEY = 'kartblitz_player';
export const PLAYER_SAVE_BACKUP_KEY = 'kartblitz_player_bak';
export const PLAYER_SAVE_META_KEY = 'kartblitz_save_meta';
export const CURRENT_SCHEMA_VERSION = 1;

export const SAVE_STATES = Object.freeze({
  LOADING: 'loading',
  LOCAL: 'local',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  CONFLICT: 'conflict',
  RECOVERED: 'recovered',
  ERROR: 'error',
});

function sumNumericFields(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let s = 0;
  for (const k of Object.keys(obj)) {
    const n = Number(obj[k]);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

/** Axes used to detect divergent progress (not a sole ranking score). */
export function progressAxes(data) {
  const d = data && typeof data === 'object' ? data : {};
  const unlocks = Array.isArray(d.unlockedTracks) ? d.unlockedTracks.length : 0;
  const sumUpg = (u) => {
    if (!u || typeof u !== 'object') return 0;
    return ['speed', 'accel', 'traction', 'braking', 'handling']
      .reduce((s, k) => s + (Number(u[k]) || 0), 0);
  };
  const rnd = d.rnd || d.teamRnd || d.research || null;
  let rndPts = 0;
  if (rnd && typeof rnd === 'object') {
    if (Array.isArray(rnd.history)) rndPts += rnd.history.length;
    if (rnd.completed && typeof rnd.completed === 'object') {
      rndPts += Object.keys(rnd.completed).length;
    }
    if (typeof rnd.level === 'number') rndPts += rnd.level;
  }
  const prog = d.programme && d.programme.nodes && typeof d.programme.nodes === 'object'
    ? d.programme.nodes
    : null;
  let programmeOwned = 0;
  if (prog) {
    for (const k of Object.keys(prog)) {
      if (prog[k] === true || prog[k] === 1 || prog[k] === '1') programmeOwned += 1;
    }
  }
  let medals = 0;
  const mastery = d.trackMastery && d.trackMastery.tracks ? d.trackMastery.tracks : null;
  if (mastery && typeof mastery === 'object') {
    for (const tid of Object.keys(mastery)) {
      const claimed = mastery[tid] && mastery[tid].claimed;
      if (!claimed) continue;
      for (const mid of Object.keys(claimed)) {
        if (claimed[mid]) medals += 1;
      }
    }
  }
  return {
    coins: Number(d.coins) || 0,
    gems: Number(d.gems) || 0,
    unlocks,
    upgrades: sumUpg(d.p1upg) + sumUpg(d.p2upg),
    development: sumNumericFields(d.p1dev) + sumNumericFields(d.p2dev),
    programme: programmeOwned,
    medals,
    rnd: rndPts + programmeOwned * 2 + medals,
  };
}

export function progressScore(data) {
  const a = progressAxes(data);
  return a.coins + a.gems * 10 + a.unlocks * 50 + a.upgrades * 5
    + a.development * 4 + a.programme * 40 + (a.medals || 0) * 25 + a.rnd * 3;
}

export function progressFingerprint(data) {
  const a = progressAxes(data);
  return `${a.coins}|${a.gems}|${a.unlocks}|${a.upgrades}|${a.development}|${a.programme}|${a.medals || 0}|${a.rnd}`;
}

export function axesDivergent(a, b) {
  const A = progressAxes(a);
  const B = progressAxes(b);
  let aAhead = false;
  let bAhead = false;
  for (const key of Object.keys(A)) {
    if (A[key] > B[key]) aAhead = true;
    if (B[key] > A[key]) bAhead = true;
  }
  return aAhead && bAhead;
}

/** True when every progress axis on `dom` is >= the same axis on `other`. */
export function axesDominates(dom, other) {
  const D = progressAxes(dom);
  const O = progressAxes(other);
  for (const key of Object.keys(O)) {
    if (D[key] < O[key]) return false;
  }
  return true;
}

export function parseSaveRaw(raw) {
  if (raw == null || raw === '') {
    return { ok: false, error: 'empty', data: null };
  }
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'invalid_shape', data: null };
    }
    return { ok: true, error: null, data };
  } catch (e) {
    return { ok: false, error: 'corrupt_json', data: null, detail: String(e && e.message || e) };
  }
}

/**
 * Migrate any legacy/cloud payload to CURRENT_SCHEMA_VERSION.
 * Never wipes progress fields — only adds metadata.
 */
export function migratePlayerSave(rawData, opts = {}) {
  const parsed = rawData && typeof rawData === 'object' ? { ...rawData } : {};
  const fromVersion = Number.isFinite(Number(parsed.schemaVersion))
    ? Number(parsed.schemaVersion)
    : 0;

  if (fromVersion < 1) {
    parsed.schemaVersion = 1;
    const existingRev = Number(parsed.revision);
    if (!Number.isFinite(existingRev) || existingRev < 1) {
      const score = progressScore(parsed);
      parsed.revision = score > 0 ? Math.max(1, Math.min(1000, 1 + Math.floor(score / 50))) : 1;
      parsed._revisionSeededFromLegacy = true;
    }
    if (!Number.isFinite(Number(parsed.updatedAt))) {
      parsed.updatedAt = Number(opts.now) || Date.now();
    }
  }

  parsed.schemaVersion = Math.max(Number(parsed.schemaVersion) || 1, CURRENT_SCHEMA_VERSION);
  parsed.revision = Math.max(1, Math.floor(Number(parsed.revision) || 1));
  return parsed;
}

export function ensureSaveMeta(meta) {
  const m = meta && typeof meta === 'object' ? { ...meta } : {};
  return {
    lastSyncedRevision: Math.max(0, Math.floor(Number(m.lastSyncedRevision) || 0)),
    lastCloudWriteRevision: Math.max(0, Math.floor(Number(m.lastCloudWriteRevision) || 0)),
    lastError: typeof m.lastError === 'string' ? m.lastError : '',
    deviceId: typeof m.deviceId === 'string' && m.deviceId ? m.deviceId : '',
  };
}

/**
 * Decide how to reconcile local vs cloud after both are migrated.
 * action: 'keep-local' | 'prefer-cloud' | 'conflict' | 'identical'
 */
export function resolveSaveConflict(localData, cloudData, metaInput = {}) {
  const meta = ensureSaveMeta(metaInput);
  const local = migratePlayerSave(localData || {});
  const cloud = migratePlayerSave(cloudData || {});

  const lr = local.revision;
  const cr = cloud.revision;
  const lastSynced = meta.lastSyncedRevision;

  const sameFp = progressFingerprint(local) === progressFingerprint(cloud);
  if (lr === cr && sameFp) {
    return { action: 'identical', reason: 'equal_revision_same_progress', local, cloud, winner: local };
  }

  if (lr === cr && !sameFp) {
    return { action: 'conflict', reason: 'equal_revision_divergent_progress', local, cloud };
  }

  if (lr > lastSynced && cr > lastSynced && lr !== cr) {
    if (axesDivergent(local, cloud)) {
      return { action: 'conflict', reason: 'divergent_branches', local, cloud };
    }
    const ls = progressScore(local);
    const cs = progressScore(cloud);
    if (cs > ls && cr >= lr && axesDominates(cloud, local)) {
      return { action: 'prefer-cloud', reason: 'cloud_strictly_richer', local, cloud, winner: cloud };
    }
    if (ls > cs && lr >= cr && axesDominates(local, cloud)) {
      return { action: 'keep-local', reason: 'local_strictly_richer', local, cloud, winner: local };
    }
    return { action: 'conflict', reason: 'divergent_branches', local, cloud };
  }

  if (cr > lr) {
    if (lr <= lastSynced) {
      return { action: 'prefer-cloud', reason: 'cloud_newer_revision', local, cloud, winner: cloud };
    }
    if (!axesDivergent(local, cloud) && axesDominates(cloud, local) && progressScore(cloud) >= progressScore(local)) {
      return { action: 'prefer-cloud', reason: 'cloud_newer_non_divergent', local, cloud, winner: cloud };
    }
    return { action: 'conflict', reason: 'cloud_newer_but_local_dirty', local, cloud };
  }

  if (lr > cr) {
    if (cr <= lastSynced || (!axesDivergent(local, cloud) && axesDominates(local, cloud))) {
      return { action: 'keep-local', reason: 'local_newer_revision', local, cloud, winner: local };
    }
    return { action: 'conflict', reason: 'local_newer_but_cloud_dirty', local, cloud };
  }

  if (axesDivergent(local, cloud)) {
    return { action: 'conflict', reason: 'fallback_divergent', local, cloud };
  }
  const ls = progressScore(local);
  const cs = progressScore(cloud);
  if (cs > ls && axesDominates(cloud, local)) {
    return { action: 'prefer-cloud', reason: 'fallback_richer_cloud', local, cloud, winner: cloud };
  }
  return { action: 'keep-local', reason: 'fallback_keep_local', local, cloud, winner: local };
}

export function nextRevision(currentData, knownCloudRevision = 0) {
  const cur = Math.max(0, Math.floor(Number(currentData && currentData.revision) || 0));
  const cloud = Math.max(0, Math.floor(Number(knownCloudRevision) || 0));
  return Math.max(cur, cloud) + 1;
}

export function prepareSavePayload(data, opts = {}) {
  const prev = opts.previous && typeof opts.previous === 'object' ? opts.previous : null;
  // Merge onto previous so UI whitelist rebuilds cannot drop unknown/cloud fields.
  const merged = prev ? { ...prev, ...(data || {}) } : { ...(data || {}) };
  let payload = migratePlayerSave(merged, { now: opts.now });

  const bump = opts.bumpRevision !== false;
  if (bump) {
    if (prev && progressFingerprint(prev) === progressFingerprint(payload)
      && Number(prev.revision) >= 1
      && opts.forceBump !== true) {
      payload.revision = Math.max(1, Math.floor(Number(prev.revision) || 1));
    } else {
      payload.revision = nextRevision(prev || payload, opts.knownCloudRevision || 0);
    }
  } else if (!Number.isFinite(Number(payload.revision)) || Number(payload.revision) < 1) {
    payload.revision = prev && Number(prev.revision) >= 1
      ? Math.floor(Number(prev.revision))
      : 1;
  }

  payload.schemaVersion = CURRENT_SCHEMA_VERSION;
  payload.updatedAt = Number(opts.now) || Date.now();
  delete payload._revisionSeededFromLegacy;
  return payload;
}

export function summarizeSaveForUi(data) {
  const a = progressAxes(data);
  return {
    revision: Math.max(0, Math.floor(Number(data && data.revision) || 0)),
    schemaVersion: Number(data && data.schemaVersion) || 0,
    coins: a.coins,
    gems: a.gems,
    unlocks: a.unlocks,
    upgrades: a.upgrades,
    development: a.development,
    rnd: a.rnd,
    updatedAt: Number(data && data.updatedAt) || 0,
    fingerprint: progressFingerprint(data),
  };
}

/**
 * In-memory controller for tests / index.html wiring.
 */
export function createSaveController(options = {}) {
  const storage = options.storage || {
    getItem: () => null,
    setItem: () => {},
  };
  const cloud = options.cloud || {
    load: async () => null,
    save: async () => {},
  };
  const nowFn = options.now || (() => Date.now());
  const listeners = new Set();
  const cloudDebounceMs = options.cloudDebounceMs != null ? options.cloudDebounceMs : 400;
  const startupTimeoutMs = options.startupTimeoutMs != null ? options.startupTimeoutMs : 5000;

  let state = SAVE_STATES.LOADING;
  let stateDetail = '';
  let ready = false;
  let conflict = null;
  let knownCloudRevision = 0;
  let meta = ensureSaveMeta(readJson(PLAYER_SAVE_META_KEY));
  let pendingCloudPayload = null;
  let cloudTimer = null;
  let cloudWriting = false;
  let writeChain = Promise.resolve();
  let lastError = null;
  let startupGate = null;
  let startupGateResolver = null;
  let lastUploadedFingerprint = '';
  let lastUploadedRevision = 0;

  function settleStartupWaiters() {
    if (startupGateResolver) {
      startupGateResolver(getState());
      startupGateResolver = null;
      startupGate = null;
    }
  }

  function readJson(key) {
    try {
      const raw = storage.getItem(key);
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeJson(key, value) {
    storage.setItem(key, JSON.stringify(value));
  }

  function setState(next, detail = '') {
    state = next;
    stateDetail = detail || '';
    for (const fn of listeners) {
      try { fn({ state, detail: stateDetail, conflict, ready, lastError }); } catch (_) {}
    }
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function backupCurrent() {
    try {
      const cur = storage.getItem(PLAYER_SAVE_KEY);
      if (cur != null && cur !== '') {
        storage.setItem(PLAYER_SAVE_BACKUP_KEY, cur);
      }
    } catch (e) {
      lastError = 'backup_failed:' + (e && e.message || e);
    }
  }

  function loadLocalRaw() {
    const primary = parseSaveRaw(storage.getItem(PLAYER_SAVE_KEY));
    if (primary.ok) {
      return { data: migratePlayerSave(primary.data, { now: nowFn() }), recovered: false };
    }
    const bak = parseSaveRaw(storage.getItem(PLAYER_SAVE_BACKUP_KEY));
    if (bak.ok) {
      const migrated = migratePlayerSave(bak.data, { now: nowFn() });
      try { writeJson(PLAYER_SAVE_KEY, migrated); } catch (_) {}
      return { data: migrated, recovered: true, error: primary.error };
    }
    return { data: migratePlayerSave({}, { now: nowFn() }), recovered: false, error: primary.error || 'missing' };
  }

  function persistMeta() {
    try {
      writeJson(PLAYER_SAVE_META_KEY, meta);
    } catch (e) {
      lastError = 'meta_write_failed:' + (e && e.message || e);
      setState(SAVE_STATES.ERROR, lastError);
    }
  }

  function writeLocal(payload, { skipBackup = false } = {}) {
    if (!skipBackup) backupCurrent();
    try {
      writeJson(PLAYER_SAVE_KEY, payload);
    } catch (e) {
      lastError = 'local_write_failed:' + (e && e.message || e);
      setState(SAVE_STATES.ERROR, lastError);
      throw e;
    }
  }

  function queueCloudWrite(payload, { force = false } = {}) {
    // Skip redundant cloud posts: same revision + same progress fingerprint.
    if (!force
      && payload.revision === lastUploadedRevision
      && progressFingerprint(payload) === lastUploadedFingerprint
      && meta.lastSyncedRevision >= payload.revision) {
      return;
    }
    // Keep only the newest revision pending so writes cannot land out of order.
    if (!pendingCloudPayload || payload.revision >= pendingCloudPayload.revision) {
      pendingCloudPayload = payload;
    }
    if (!ready) return;
    if (state === SAVE_STATES.CONFLICT) return;
    if (cloudTimer) clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => {
      cloudTimer = null;
      flushCloudQueue();
    }, cloudDebounceMs);
    if (typeof cloudTimer.unref === 'function') cloudTimer.unref();
  }

  function flushCloudQueue() {
    if (!ready || cloudWriting || !pendingCloudPayload) return writeChain;
    if (state === SAVE_STATES.CONFLICT) return writeChain;
    const payload = pendingCloudPayload;
    pendingCloudPayload = null;
    cloudWriting = true;
    setState(SAVE_STATES.SYNCING, `rev_${payload.revision}`);
    writeChain = writeChain.then(async () => {
      try {
        await cloud.save(payload);
        knownCloudRevision = Math.max(knownCloudRevision, payload.revision);
        meta.lastSyncedRevision = Math.max(meta.lastSyncedRevision, payload.revision);
        meta.lastCloudWriteRevision = payload.revision;
        meta.lastError = '';
        lastError = null;
        lastUploadedRevision = payload.revision;
        lastUploadedFingerprint = progressFingerprint(payload);
        persistMeta();
        if (state !== SAVE_STATES.CONFLICT) setState(SAVE_STATES.SYNCED, `rev_${payload.revision}`);
      } catch (e) {
        // Keep the failed payload queued for an explicit retry / later flush,
        // but do not auto-loop forever here.
        if (!pendingCloudPayload || pendingCloudPayload.revision < payload.revision) {
          pendingCloudPayload = payload;
        }
        lastError = 'cloud_write_failed:' + (e && e.message || e);
        meta.lastError = lastError;
        persistMeta();
        setState(SAVE_STATES.ERROR, lastError);
      } finally {
        cloudWriting = false;
        // A newer revision may have arrived while this write was in flight.
        if (pendingCloudPayload && state !== SAVE_STATES.CONFLICT) {
          if (cloudTimer) clearTimeout(cloudTimer);
          cloudTimer = setTimeout(() => {
            cloudTimer = null;
            flushCloudQueue();
          }, cloudDebounceMs);
          if (typeof cloudTimer.unref === 'function') cloudTimer.unref();
        }
      }
    });
    return writeChain;
  }

  function commitLocal(payload, { upload = true, skipBackup = false, forceUpload = false } = {}) {
    writeLocal(payload, { skipBackup });
    if (upload) queueCloudWrite(payload, { force: forceUpload });
    return payload;
  }

  function save(data, opts = {}) {
    if (state === SAVE_STATES.CONFLICT && opts.allowDuringConflict !== true) {
      lastError = 'save_blocked_during_conflict';
      setState(SAVE_STATES.CONFLICT, lastError);
      const err = new Error(lastError);
      err.code = 'SAVE_CONFLICT_BLOCKED';
      throw err;
    }

    const prevPack = loadLocalRaw();
    const previous = prevPack.data;
    const payload = prepareSavePayload(data, {
      previous,
      knownCloudRevision,
      now: nowFn(),
      bumpRevision: opts.bumpRevision !== false,
      forceBump: !!opts.forceBump,
    });
    return commitLocal(payload, {
      upload: opts.upload !== false,
      forceUpload: !!opts.forceUpload,
    });
  }

  function applyWinner(winner, reason) {
    const payload = migratePlayerSave(winner, { now: nowFn() });
    knownCloudRevision = Math.max(knownCloudRevision, payload.revision);
    meta.lastSyncedRevision = Math.max(meta.lastSyncedRevision, payload.revision);
    persistMeta();
    conflict = null;
    commitLocal(payload, { upload: true, forceUpload: true });
    setState(SAVE_STATES.SYNCED, reason);
    return payload;
  }

  function chooseConflictSide(side) {
    if (!conflict) return null;
    const winner = side === 'cloud' ? conflict.cloud : conflict.local;
    conflict = null;
    const payload = applyWinner(winner, side === 'cloud' ? 'user_chose_cloud' : 'user_chose_local');
    settleStartupWaiters();
    return payload;
  }

  function waitUntilReady() {
    // Block gameplay until startup cloud resolve finishes, and until any
    // divergent conflict is explicitly chosen (never silently discard).
    if (ready && state !== SAVE_STATES.CONFLICT) return Promise.resolve(getState());
    if (!startupGate) {
      startupGate = new Promise((resolve) => { startupGateResolver = resolve; });
    }
    return startupGate;
  }

  function enterConflict(local, cloud, reason) {
    conflict = {
      local,
      cloud,
      reason,
      localSummary: summarizeSaveForUi(local),
      cloudSummary: summarizeSaveForUi(cloud),
    };
    setState(SAVE_STATES.CONFLICT, reason);
  }

  async function resolveStartup() {
    setState(SAVE_STATES.LOADING, 'startup');
    const localPack = loadLocalRaw();
    let local = localPack.data;
    const localAtStartFp = progressFingerprint(local);
    const localAtStartRev = local.revision;
    try {
      writeLocal(local, { skipBackup: !localPack.recovered });
    } catch (_) {}

    if (localPack.recovered) {
      setState(SAVE_STATES.RECOVERED, localPack.error || 'backup');
    }

    let cloudData = null;
    let cloudErr = null;
    let timeoutId = null;
    try {
      const result = await Promise.race([
        cloud.load().then((d) => ({ ok: true, d })).catch((e) => ({ ok: false, e })),
        new Promise((resolve) => {
          // Do NOT unref — must keep the event loop alive while cloud.load is pending.
          timeoutId = setTimeout(() => resolve({ ok: false, e: new Error('startup_timeout') }), startupTimeoutMs);
        }),
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      if (result.ok) cloudData = result.d;
      else cloudErr = result.e;
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId);
      cloudErr = e;
    }

    // Re-read local in case anything wrote during the wait.
    local = loadLocalRaw().data;
    const localDirtiedDuringLoad =
      progressFingerprint(local) !== localAtStartFp
      || local.revision > localAtStartRev;

    ready = true;

    if (cloudErr && !cloudData) {
      lastError = cloudErr && cloudErr.message === 'startup_timeout'
        ? 'cloud_timeout'
        : ('cloud_load_failed:' + (cloudErr && cloudErr.message || cloudErr));
      setState(localPack.recovered ? SAVE_STATES.RECOVERED : SAVE_STATES.LOCAL, lastError);
      settleStartupWaiters();
      flushCloudQueue();
      return { local, cloud: null, decision: { action: 'keep-local', reason: lastError } };
    }

    if (!cloudData) {
      setState(SAVE_STATES.LOCAL, 'no_cloud_save');
      queueCloudWrite(local, { force: true });
      settleStartupWaiters();
      flushCloudQueue();
      return { local, cloud: null, decision: { action: 'keep-local', reason: 'no_cloud_save' } };
    }

    const cloudMigrated = migratePlayerSave(cloudData, { now: nowFn() });
    knownCloudRevision = Math.max(knownCloudRevision, cloudMigrated.revision);
    let decision = resolveSaveConflict(local, cloudMigrated, meta);

    // Never silently discard local progress earned while cloud was loading.
    if (decision.action === 'prefer-cloud' && localDirtiedDuringLoad) {
      if (!axesDominates(cloudMigrated, local)
        || progressFingerprint(local) !== progressFingerprint(cloudMigrated)) {
        decision = {
          action: 'conflict',
          reason: 'local_dirty_during_cloud_load',
          local,
          cloud: cloudMigrated,
        };
      }
    }

    if (decision.action === 'prefer-cloud') {
      local = applyWinner(decision.winner, decision.reason);
      settleStartupWaiters();
    } else if (decision.action === 'keep-local' || decision.action === 'identical') {
      meta.lastSyncedRevision = Math.max(meta.lastSyncedRevision, local.revision, cloudMigrated.revision);
      persistMeta();
      if (decision.action === 'keep-local' && local.revision >= cloudMigrated.revision) {
        queueCloudWrite(local, { force: true });
      }
      setState(SAVE_STATES.SYNCED, decision.reason);
      settleStartupWaiters();
    } else if (decision.action === 'conflict') {
      enterConflict(decision.local, decision.cloud, decision.reason);
      // Do not settle waiters — gameplay stays gated until chooseConflictSide.
    } else {
      settleStartupWaiters();
    }

    flushCloudQueue();
    return { local, cloud: cloudMigrated, decision };
  }

  function getState() {
    return {
      state,
      detail: stateDetail,
      ready,
      conflict,
      lastError,
      meta: { ...meta },
      knownCloudRevision,
      pendingCloudRevision: pendingCloudPayload ? pendingCloudPayload.revision : 0,
    };
  }

  function isReady() {
    return ready && state !== SAVE_STATES.CONFLICT;
  }

  function retryCloudSync() {
    if (state === SAVE_STATES.CONFLICT) return writeChain;
    if (pendingCloudPayload) return _flushCloudNow();
    const local = loadLocalRaw().data;
    queueCloudWrite(local, { force: true });
    return _flushCloudNow();
  }

  function _flushCloudNow() {
    if (cloudTimer) {
      clearTimeout(cloudTimer);
      cloudTimer = null;
    }
    return flushCloudQueue();
  }

  return {
    SAVE_STATES,
    onChange,
    getState,
    isReady,
    waitUntilReady,
    loadLocalRaw,
    save,
    resolveStartup,
    chooseConflictSide,
    queueCloudWrite,
    flushCloudQueue,
    retryCloudSync,
    prepareSavePayload,
    migratePlayerSave,
    resolveSaveConflict,
    summarizeSaveForUi,
    _flushCloudNow,
    getMeta: () => ({ ...meta }),
  };
}

export default {
  CURRENT_SCHEMA_VERSION,
  PLAYER_SAVE_KEY,
  PLAYER_SAVE_BACKUP_KEY,
  PLAYER_SAVE_META_KEY,
  SAVE_STATES,
  progressAxes,
  progressScore,
  progressFingerprint,
  axesDivergent,
  axesDominates,
  parseSaveRaw,
  migratePlayerSave,
  ensureSaveMeta,
  resolveSaveConflict,
  nextRevision,
  prepareSavePayload,
  summarizeSaveForUi,
  createSaveController,
};
