/**
 * Tests for unified upgrade programme migration + effects.
 */
import assert from 'assert';
import {
  PROGRAMME_NODES,
  PROGRAMME_BRANCHES,
  DEV_TO_PROGRAMME,
  RND_TO_PROGRAMME,
  migrateToProgramme,
  applyProgrammeMigration,
  computeProgrammeBonuses,
  computeProgrammeTyreWearMult,
  purchaseProgrammeNode,
  canPurchaseProgrammeNode,
  exportProgrammeUpgradeStats,
  normalizeProgrammeState,
  createEmptyProgrammeState,
} from '../upgrade-programme.mjs';

assert.strictEqual(PROGRAMME_BRANCHES.length, 4);
assert.strictEqual(PROGRAMME_NODES.length, 12);

// Mapping coverage: every known DEV + R&D id maps somewhere
{
  const targets = new Set(PROGRAMME_NODES.map((n) => n.id));
  for (const v of Object.values(DEV_TO_PROGRAMME)) assert.ok(targets.has(v), v);
  for (const v of Object.values(RND_TO_PROGRAMME)) assert.ok(targets.has(v), v);
  assert.strictEqual(Object.keys(DEV_TO_PROGRAMME).length, 12);
  assert.strictEqual(Object.keys(RND_TO_PROGRAMME).length, 24);
}

// Fresh player
{
  const r = migrateToProgramme({ coins: 100 });
  assert.strictEqual(r.refund, 0);
  assert.strictEqual(r.coins, 100);
  assert.ok(r.programme.migrated);
  assert.strictEqual(r.unlocked.length, 0);
}

// DEV implemented maps without wiping coins beyond fair refund
{
  const pd = {
    coins: 50,
    p1dev: {
      'eng-intake': 2,
      'eng-ecu': 2,
      'chassis-susp': 2,
    },
    p2dev: {},
  };
  const r = migrateToProgramme(pd);
  assert.ok(r.programme.nodes['pt-intake']);
  assert.ok(r.programme.nodes['pt-ecu']);
  assert.ok(r.programme.nodes['ch-susp']);
  assert.ok(!r.programme.nodes['pt-unit']);
  // Spent: 160+250+170 = 580; unlock cost same -> refund 0
  assert.strictEqual(r.refund, 0);
  assert.strictEqual(r.coins, 50);
}

// Duplicate DEV + R&D for same node unlocks once and refunds excess
{
  const pd = {
    coins: 0,
    p1dev: { 'eng-intake': 2 },
    p2dev: {},
    rnd: {
      nodes: {
        'engine-intake': { status: 'complete', attempts: 1, lastCost: 120 },
      },
    },
  };
  const r = migrateToProgramme(pd);
  assert.ok(r.programme.nodes['pt-intake']);
  // spent 160 + 120 = 280, unlock 160 => refund 120
  assert.strictEqual(r.refund, 120);
  assert.strictEqual(r.coins, 120);
}

// Incomplete R&D refunds spend
{
  const pd = {
    coins: 10,
    rnd: {
      nodes: {
        'tyres-temp': { status: 'researching', attempts: 1, lastCost: 100, remaining: 1 },
      },
    },
  };
  const r = migrateToProgramme(pd);
  assert.ok(!r.programme.nodes['rs-tyres']);
  assert.strictEqual(r.refund, 100);
  assert.strictEqual(r.coins, 110);
}

// DEV stage-1 (researched only) refunds research cost
{
  const pd = {
    coins: 0,
    p1dev: { 'aero-front': 1 },
    p2dev: {},
  };
  const r = migrateToProgramme(pd);
  assert.ok(!r.programme.nodes['ae-front']);
  assert.strictEqual(r.refund, 80);
}

// Prereq chain auto-filled when later node owned via mapping
{
  const pd = {
    coins: 0,
    p1dev: { 'eng-internals': 2 },
    p2dev: {},
  };
  const r = migrateToProgramme(pd);
  assert.ok(r.programme.nodes['pt-unit']);
  assert.ok(r.programme.nodes['pt-ecu'], 'prereq auto-owned');
  assert.ok(r.programme.nodes['pt-intake'], 'root auto-owned');
}

// Idempotent migration
{
  const first = applyProgrammeMigration({
    coins: 5,
    p1dev: { 'eng-intake': 2 },
  });
  const second = applyProgrammeMigration(first.playerData);
  assert.ok(second.alreadyMigrated);
  assert.strictEqual(second.refund, 0);
  assert.strictEqual(second.playerData.coins, first.playerData.coins);
}

// Purchase respects prereqs and coins
{
  let prog = createEmptyProgrammeState();
  prog.migrated = true;
  assert.ok(!canPurchaseProgrammeNode(prog, 'pt-ecu', 999).ok);
  let buy = purchaseProgrammeNode(prog, 'pt-intake', 200);
  assert.ok(buy.ok);
  assert.strictEqual(buy.coins, 40);
  prog = buy.programme;
  buy = purchaseProgrammeNode(prog, 'pt-ecu', buy.coins);
  assert.ok(!buy.ok);
  buy = purchaseProgrammeNode(prog, 'pt-ecu', 300);
  assert.ok(buy.ok);
}

// Effects do not double-stack duplicate branches
{
  const prog = normalizeProgrammeState({
    migrated: true,
    nodes: {
      'pt-intake': true,
      'pt-ecu': true,
      'ch-susp': true,
      'rs-tyres': true,
    },
  });
  const b = computeProgrammeBonuses(prog);
  assert.strictEqual(b.accel, 26 + 18);
  assert.strictEqual(b.speed, 30);
  assert.strictEqual(b.handling, 0.16);
  assert.strictEqual(b.traction, 18 + 22);
  assert.ok(b.ersCharge > 0);
  const wear = computeProgrammeTyreWearMult(prog);
  assert.ok(wear < 1);
  assert.ok(wear >= 0.7);
}

// Export blob shape for online
{
  const prog = normalizeProgrammeState({
    migrated: true,
    nodes: { 'pt-intake': true },
  });
  const blob = exportProgrammeUpgradeStats(prog, { speedMult: 1.1, turnMult: 1, brakeMult: 1, tractBonus: 0 });
  assert.strictEqual(blob.accel, 26);
  assert.strictEqual(blob.speedMult, 1.1);
  assert.ok(typeof blob.tyreWearMult === 'number');
}

console.log('upgrade-programme tests: OK');
