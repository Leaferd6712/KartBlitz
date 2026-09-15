/**
 * Tests for versioned player save persistence / cloud conflict resolution.
 */
import assert from 'assert';
import {
  CURRENT_SCHEMA_VERSION,
  PLAYER_SAVE_KEY,
  PLAYER_SAVE_BACKUP_KEY,
  PLAYER_SAVE_META_KEY,
  SAVE_STATES,
  migratePlayerSave,
  prepareSavePayload,
  resolveSaveConflict,
  progressFingerprint,
  progressScore,
  axesDominates,
  parseSaveRaw,
  createSaveController,
  summarizeSaveForUi,
} from '../player-save.mjs';

function memStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
    _data: data,
  };
}

function legacySave(overrides = {}) {
  return {
    coins: 120,
    gems: 0,
    unlockedTracks: [0, 1, 2, 3, 4, 5],
    p1upg: { speed: 2, accel: 1, traction: 0, braking: 0, handling: 1 },
    p2upg: { speed: 0, accel: 0, traction: 0, braking: 0, handling: 0 },
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Legacy migration
{
  const legacy = legacySave();
  const migrated = migratePlayerSave(legacy, { now: 100 });
  assert.strictEqual(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.ok(migrated.revision >= 1);
  assert.strictEqual(migrated.coins, 120, 'migration must not reset coins');
  assert.deepStrictEqual(migrated.unlockedTracks, legacy.unlockedTracks);
  assert.strictEqual(migrated.p1upg.speed, 2);
}
{
  const blank = migratePlayerSave({}, { now: 50 });
  assert.strictEqual(blank.schemaVersion, 1);
  assert.strictEqual(blank.revision, 1);
}
{
  const already = migratePlayerSave({ schemaVersion: 1, revision: 9, coins: 10 }, { now: 1 });
  assert.strictEqual(already.revision, 9);
  assert.strictEqual(already.coins, 10);
}

// Local newer
{
  const local = migratePlayerSave({ coins: 200, revision: 5, schemaVersion: 1 });
  const cloud = migratePlayerSave({ coins: 50, revision: 3, schemaVersion: 1 });
  const d = resolveSaveConflict(local, cloud, { lastSyncedRevision: 3 });
  assert.strictEqual(d.action, 'keep-local');
}

// Cloud newer
{
  const local = migratePlayerSave({ coins: 50, revision: 3, schemaVersion: 1 });
  const cloud = migratePlayerSave({ coins: 200, revision: 7, schemaVersion: 1 });
  const d = resolveSaveConflict(local, cloud, { lastSyncedRevision: 3 });
  assert.strictEqual(d.action, 'prefer-cloud');
}

// Equal revision same progress
{
  const local = migratePlayerSave({ coins: 10, revision: 4, schemaVersion: 1, unlockedTracks: [0] });
  const cloud = migratePlayerSave({ coins: 10, revision: 4, schemaVersion: 1, unlockedTracks: [0] });
  const d = resolveSaveConflict(local, cloud, { lastSyncedRevision: 4 });
  assert.strictEqual(d.action, 'identical');
}

// Equal revision divergent progress
{
  const local = migratePlayerSave({ coins: 100, revision: 4, schemaVersion: 1, unlockedTracks: [0] });
  const cloud = migratePlayerSave({ coins: 10, revision: 4, schemaVersion: 1, unlockedTracks: [0, 1, 2, 3, 4, 5, 6] });
  const d = resolveSaveConflict(local, cloud, { lastSyncedRevision: 3 });
  assert.strictEqual(d.action, 'conflict');
  assert.strictEqual(d.reason, 'equal_revision_divergent_progress');
}

// Clock skew must not prefer older-progress cloud by updatedAt alone
{
  const local = migratePlayerSave({
    coins: 500, revision: 8, schemaVersion: 1, updatedAt: 1000,
    unlockedTracks: [0, 1, 2],
  });
  const cloud = migratePlayerSave({
    coins: 10, revision: 2, schemaVersion: 1, updatedAt: 9999999999999,
    unlockedTracks: [0],
  });
  const d = resolveSaveConflict(local, cloud, { lastSyncedRevision: 2 });
  assert.notStrictEqual(d.action, 'prefer-cloud', 'wall-clock must not override newer local revision');
  assert.strictEqual(d.action, 'keep-local');
}

// Corrupted save recovers from backup
{
  const good = prepareSavePayload(legacySave({ coins: 333 }), { now: 10, bumpRevision: true });
  const storage = memStorage({
    [PLAYER_SAVE_KEY]: '{not-json',
    [PLAYER_SAVE_BACKUP_KEY]: JSON.stringify(good),
  });
  const ctrl = createSaveController({
    storage,
    cloud: { load: async () => null, save: async () => {} },
    cloudDebounceMs: 0,
    startupTimeoutMs: 50,
    now: () => 20,
  });
  const pack = ctrl.loadLocalRaw();
  assert.strictEqual(pack.recovered, true);
  assert.strictEqual(pack.data.coins, 333);
}

// Cloud failure surfaces error state
{
  const storage = memStorage();
  let saveCalls = 0;
  const ctrl = createSaveController({
    storage,
    cloud: {
      load: async () => null,
      save: async () => { saveCalls++; throw new Error('network_down'); },
    },
    cloudDebounceMs: 0,
    startupTimeoutMs: 30,
    now: () => 100,
  });
  await ctrl.resolveStartup();
  ctrl.save({ coins: 40, unlockedTracks: [0] });
  await ctrl._flushCloudNow();
  await sleep(20);
  const st = ctrl.getState();
  assert.ok(saveCalls >= 1);
  assert.strictEqual(st.state, SAVE_STATES.ERROR);
  assert.ok(String(st.lastError).includes('cloud_write_failed'));
  const local = JSON.parse(storage.getItem(PLAYER_SAVE_KEY));
  assert.strictEqual(local.coins, 40);
}

// Interrupted cloud write requeues
{
  const storage = memStorage();
  const writes = [];
  let failOnce = true;
  const ctrl = createSaveController({
    storage,
    cloud: {
      load: async () => null,
      save: async (payload) => {
        writes.push(payload.revision);
        if (failOnce) { failOnce = false; throw new Error('interrupted'); }
      },
    },
    cloudDebounceMs: 0,
    startupTimeoutMs: 30,
    now: () => 200,
  });
  await ctrl.resolveStartup();
  ctrl.save({ coins: 1, unlockedTracks: [0] }, { forceBump: true });
  await ctrl._flushCloudNow();
  await sleep(20);
  await ctrl._flushCloudNow();
  await sleep(20);
  assert.ok(writes.length >= 2, 'should retry interrupted write');
  assert.ok(writes[0] <= writes[writes.length - 1], 'revisions must not go backwards');
}

// Cloud newer applied via controller
{
  const local = prepareSavePayload(legacySave({ coins: 20 }), { now: 1, bumpRevision: true });
  local.revision = 2;
  const storage = memStorage({
    [PLAYER_SAVE_KEY]: JSON.stringify(local),
    [PLAYER_SAVE_META_KEY]: JSON.stringify({ lastSyncedRevision: 2 }),
  });
  const cloudPayload = prepareSavePayload(legacySave({ coins: 900 }), { now: 2 });
  cloudPayload.revision = 5;
  const ctrl = createSaveController({
    storage,
    cloud: { load: async () => cloudPayload, save: async () => {} },
    cloudDebounceMs: 0,
    startupTimeoutMs: 200,
    now: () => 3,
  });
  const result = await ctrl.resolveStartup();
  assert.strictEqual(result.decision.action, 'prefer-cloud');
  const stored = JSON.parse(storage.getItem(PLAYER_SAVE_KEY));
  assert.strictEqual(stored.coins, 900);
  assert.strictEqual(stored.revision, 5);
  await ctrl._flushCloudNow();
}

// Divergent branches conflict + choose local + gate
{
  const local = migratePlayerSave({
    schemaVersion: 1, revision: 6, coins: 500, unlockedTracks: [0],
    p1upg: { speed: 5, accel: 0, traction: 0, braking: 0, handling: 0 },
  });
  const cloud = migratePlayerSave({
    schemaVersion: 1, revision: 7, coins: 10, unlockedTracks: [0, 1, 2, 3, 4, 5, 6, 7],
    p1upg: { speed: 0, accel: 0, traction: 0, braking: 0, handling: 0 },
  });
  const storage = memStorage({
    [PLAYER_SAVE_KEY]: JSON.stringify(local),
    [PLAYER_SAVE_META_KEY]: JSON.stringify({ lastSyncedRevision: 4 }),
  });
  const ctrl = createSaveController({
    storage,
    cloud: { load: async () => cloud, save: async () => {} },
    cloudDebounceMs: 0,
    startupTimeoutMs: 200,
    now: () => 9,
  });
  const result = await ctrl.resolveStartup();
  assert.strictEqual(result.decision.action, 'conflict');
  assert.strictEqual(ctrl.getState().state, SAVE_STATES.CONFLICT);
  let readyResolved = false;
  const readyPromise = ctrl.waitUntilReady().then(() => { readyResolved = true; });
  await sleep(20);
  assert.strictEqual(readyResolved, false, 'gameplay must stay gated during conflict');

  let blocked = false;
  try {
    ctrl.save({ coins: 999 });
  } catch (e) {
    blocked = e && e.code === 'SAVE_CONFLICT_BLOCKED';
  }
  assert.ok(blocked, 'saves must be blocked during conflict');

  ctrl.chooseConflictSide('local');
  await readyPromise;
  assert.strictEqual(readyResolved, true);
  const stored = JSON.parse(storage.getItem(PLAYER_SAVE_KEY));
  assert.strictEqual(stored.coins, 500);
  assert.strictEqual(ctrl.getState().state, SAVE_STATES.SYNCED);
  await ctrl._flushCloudNow();
}

// No revision bump when fingerprint unchanged
{
  const prev = prepareSavePayload({ coins: 10, unlockedTracks: [0] }, { now: 1 });
  const again = prepareSavePayload({ coins: 10, unlockedTracks: [0] }, { now: 2, previous: prev });
  assert.strictEqual(again.revision, prev.revision);
}

// Merge preserves unknown previous fields (whitelist-safe)
{
  const prev = prepareSavePayload({ coins: 10, unlockedTracks: [0], secretFlag: true }, { now: 1 });
  const next = prepareSavePayload({ coins: 11, unlockedTracks: [0] }, { now: 2, previous: prev });
  assert.strictEqual(next.secretFlag, true);
  assert.strictEqual(next.coins, 11);
}

{
  assert.strictEqual(parseSaveRaw('{').ok, false);
  assert.strictEqual(parseSaveRaw('[]').ok, false);
  assert.strictEqual(parseSaveRaw('{"coins":1}').ok, true);
}

{
  const s = summarizeSaveForUi(migratePlayerSave(legacySave()));
  assert.ok(s.revision >= 1);
  assert.strictEqual(s.coins, 120);
}

{
  const a = progressFingerprint(legacySave({ coins: 1 }));
  const b = progressFingerprint(legacySave({ coins: 1 }));
  const c = progressFingerprint(legacySave({ coins: 2 }));
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.ok(progressScore(legacySave({ coins: 100 })) > progressScore(legacySave({ coins: 1 })));
  assert.ok(axesDominates(
    { coins: 10, unlockedTracks: [0, 1] },
    { coins: 5, unlockedTracks: [0] }
  ));
  assert.ok(!axesDominates(
    { coins: 10, unlockedTracks: [0] },
    { coins: 5, unlockedTracks: [0, 1, 2] }
  ));
}

// Out-of-order cloud writes: only newest revision should land last
{
  const storage = memStorage();
  const writes = [];
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  let call = 0;
  const ctrl = createSaveController({
    storage,
    cloud: {
      load: async () => null,
      save: async (payload) => {
        call += 1;
        if (call === 1) await firstGate;
        writes.push(payload.revision);
      },
    },
    cloudDebounceMs: 0,
    startupTimeoutMs: 30,
    now: () => 300,
  });
  await ctrl.resolveStartup();
  ctrl.save({ coins: 1, unlockedTracks: [0] }, { forceBump: true });
  const firstFlush = ctrl._flushCloudNow();
  await sleep(5);
  ctrl.save({ coins: 2, unlockedTracks: [0] }, { forceBump: true });
  ctrl.save({ coins: 3, unlockedTracks: [0] }, { forceBump: true });
  releaseFirst();
  await firstFlush;
  await ctrl._flushCloudNow();
  await sleep(20);
  assert.ok(writes.length >= 2);
  assert.strictEqual(writes[writes.length - 1], Math.max(...writes), 'newest revision must win');
}

// Local dirty during cloud load must not be silently overwritten
{
  const local = migratePlayerSave({
    schemaVersion: 1, revision: 3, coins: 50, unlockedTracks: [0],
  });
  const storage = memStorage({
    [PLAYER_SAVE_KEY]: JSON.stringify(local),
    [PLAYER_SAVE_META_KEY]: JSON.stringify({ lastSyncedRevision: 3 }),
  });
  let resolveLoad;
  const loadGate = new Promise((r) => { resolveLoad = r; });
  const cloudPayload = migratePlayerSave({
    schemaVersion: 1, revision: 8, coins: 40, unlockedTracks: [0, 1, 2, 3, 4],
  });
  const ctrl = createSaveController({
    storage,
    cloud: {
      load: async () => { await loadGate; return cloudPayload; },
      save: async () => {},
    },
    cloudDebounceMs: 0,
    startupTimeoutMs: 2000,
    now: () => 400,
  });
  const startup = ctrl.resolveStartup();
  await sleep(10);
  // Earn coins while cloud is still loading.
  ctrl.save({ coins: 500, unlockedTracks: [0] }, { forceBump: true });
  resolveLoad();
  const result = await startup;
  assert.strictEqual(result.decision.action, 'conflict', 'dirty local during load must conflict');
  assert.strictEqual(ctrl.getState().state, SAVE_STATES.CONFLICT);
  ctrl.chooseConflictSide('local');
  const stored = JSON.parse(storage.getItem(PLAYER_SAVE_KEY));
  assert.strictEqual(stored.coins, 500);
  await ctrl._flushCloudNow();
}

// Backup slot populated on meaningful overwrite
{
  const storage = memStorage({
    [PLAYER_SAVE_KEY]: JSON.stringify(migratePlayerSave({ coins: 77, revision: 2, schemaVersion: 1 })),
  });
  const ctrl = createSaveController({
    storage,
    cloud: { load: async () => null, save: async () => {} },
    cloudDebounceMs: 0,
    startupTimeoutMs: 30,
    now: () => 500,
  });
  await ctrl.resolveStartup();
  ctrl.save({ coins: 88, unlockedTracks: [0] }, { forceBump: true });
  const bak = JSON.parse(storage.getItem(PLAYER_SAVE_BACKUP_KEY));
  assert.ok(bak);
  assert.ok(bak.coins === 77 || bak.coins === 88);
}

// Retry after cloud failure
{
  const storage = memStorage();
  let fail = true;
  let saves = 0;
  const ctrl = createSaveController({
    storage,
    cloud: {
      load: async () => null,
      save: async () => {
        saves += 1;
        if (fail) throw new Error('temp');
      },
    },
    cloudDebounceMs: 0,
    startupTimeoutMs: 30,
    now: () => 600,
  });
  await ctrl.resolveStartup();
  ctrl.save({ coins: 9, unlockedTracks: [0] }, { forceBump: true });
  await ctrl._flushCloudNow();
  await sleep(10);
  assert.strictEqual(ctrl.getState().state, SAVE_STATES.ERROR);
  fail = false;
  await ctrl.retryCloudSync();
  await sleep(10);
  assert.strictEqual(ctrl.getState().state, SAVE_STATES.SYNCED);
  assert.ok(saves >= 2);
}

console.log('player-save tests: OK');
