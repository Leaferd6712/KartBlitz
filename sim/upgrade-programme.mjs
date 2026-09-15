/**
 * KartBlitz unified upgrade programme.
 * Replaces duplicated Development/Build (12 parts) + R&D HQ (24 nodes).
 *
 * Mapping (OLD -> NEW / REFUND):
 *   eng-intake, engine-intake              -> pt-intake
 *   eng-ecu, engine-ecu                  -> pt-ecu
 *   eng-internals, eng-final-drive,
 *     engine-internals                   -> pt-unit
 *   engine-ice, rel-cooling, rel-sensors,
 *     rel-durability, rel-master         -> rs-reliability
 *   chassis-susp, chassis-geometry       -> ch-susp
 *   chassis-brakes (dev+rnd)             -> ch-brakes
 *   chassis-weight, chassis-rack (both)  -> ch-agile
 *   aero-front, aero-canards             -> ae-front
 *   aero-floor, aero-diffuser (both)     -> ae-underbody
 *   aero-wing (dev+rnd)                  -> ae-wing
 *   tyres-temp|structure|compound|window -> rs-tyres
 *   ers-harvest|deploy|cell|control      -> rs-ers
 *   Incomplete R&D spends / stage-1 DEV  -> coin refund (migration credit)
 *   Duplicate spends for same NEW node   -> refund excess
 */

export const PROGRAMME_SCHEMA_VERSION = 1;

/** @typedef {{ speed?: number, accel?: number, traction?: number, braking?: number, handling?: number, tyreWear?: number, reliability?: number, ersCharge?: number, ersBoost?: number }} ProgrammeEffects */

/**
 * @typedef {object} ProgrammeNodeDef
 * @property {string} id
 * @property {string} branchId
 * @property {string} code
 * @property {string} name
 * @property {string} desc
 * @property {number} cost
 * @property {string|null} requires
 * @property {ProgrammeEffects} effects
 */

/**
 * @typedef {object} ProgrammeBranchDef
 * @property {string} id
 * @property {string} name
 * @property {string} accent
 * @property {string} summary
 * @property {ProgrammeNodeDef[]} nodes
 */

/** @type {ProgrammeBranchDef[]} */
export const PROGRAMME_BRANCHES = [
  {
    id: 'powertrain',
    name: 'POWERTRAIN',
    accent: '#00f5ff',
    summary: 'Power delivery, driveline, and hybrid deploy.',
    nodes: [
      {
        id: 'pt-intake',
        branchId: 'powertrain',
        code: 'P-01',
        name: 'High-Flow Intake',
        desc: 'Sharper throttle pickup out of slow corners.',
        cost: 160,
        requires: null,
        effects: { accel: 26 },
      },
      {
        id: 'pt-ecu',
        branchId: 'powertrain',
        code: 'P-02',
        name: 'Race ECU Mapping',
        desc: 'Cleaner delivery with light ERS harvest assist.',
        cost: 250,
        requires: 'pt-intake',
        effects: { speed: 30, accel: 18, ersCharge: 0.03, reliability: -0.01 },
      },
      {
        id: 'pt-unit',
        branchId: 'powertrain',
        code: 'P-03',
        name: 'Power Unit Spec',
        desc: 'Top-end pull plus aggressive ERS deployment.',
        cost: 520,
        requires: 'pt-ecu',
        effects: { speed: 48, accel: 28, ersBoost: 0.06 },
      },
    ],
  },
  {
    id: 'chassis',
    name: 'CHASSIS & HANDLING',
    accent: '#ffd700',
    summary: 'Platform grip, braking confidence, and rotation.',
    nodes: [
      {
        id: 'ch-susp',
        branchId: 'chassis',
        code: 'C-01',
        name: 'Suspension Geometry',
        desc: 'Keeps the kart settled over weight transfer.',
        cost: 170,
        requires: null,
        effects: { handling: 0.16, traction: 18 },
      },
      {
        id: 'ch-brakes',
        branchId: 'chassis',
        code: 'C-02',
        name: 'Brake Package',
        desc: 'Brake later with less fade.',
        cost: 235,
        requires: 'ch-susp',
        effects: { braking: 120, reliability: 0.03 },
      },
      {
        id: 'ch-agile',
        branchId: 'chassis',
        code: 'C-03',
        name: 'Agile Chassis Spec',
        desc: 'Weight shed and quicker steering response.',
        cost: 420,
        requires: 'ch-brakes',
        effects: { handling: 0.30, braking: 70, accel: 20 },
      },
    ],
  },
  {
    id: 'aero',
    name: 'AERODYNAMICS',
    accent: '#ff6b35',
    summary: 'Downforce packages and drag management.',
    nodes: [
      {
        id: 'ae-front',
        branchId: 'aero',
        code: 'A-01',
        name: 'Front Canards',
        desc: 'Front bite in medium-speed sections.',
        cost: 180,
        requires: null,
        effects: { handling: 0.14 },
      },
      {
        id: 'ae-underbody',
        branchId: 'aero',
        code: 'A-02',
        name: 'Underbody Package',
        desc: 'Floor tunnels and diffuser grip without double-stacking.',
        cost: 400,
        requires: 'ae-front',
        effects: { handling: 0.28, traction: 28 },
      },
      {
        id: 'ae-wing',
        branchId: 'aero',
        code: 'A-03',
        name: 'Low-Drag Wing',
        desc: 'Straight-line efficiency with loaded rear stability.',
        cost: 460,
        requires: 'ae-underbody',
        effects: { speed: 28, handling: 0.16 },
      },
    ],
  },
  {
    id: 'race',
    name: 'RACE SYSTEMS',
    accent: '#4ade80',
    summary: 'Tyres, durability, and ERS race ops — unique former R&D value.',
    nodes: [
      {
        id: 'rs-tyres',
        branchId: 'race',
        code: 'R-01',
        name: 'Tyre Window Science',
        desc: 'Broader working range and slower wear.',
        cost: 280,
        requires: null,
        effects: { traction: 22, tyreWear: 0.08 },
      },
      {
        id: 'rs-reliability',
        branchId: 'race',
        code: 'R-02',
        name: 'Cooling & Durability',
        desc: 'Thermal control and race-proofing.',
        cost: 360,
        requires: 'rs-tyres',
        effects: { tyreWear: 0.06, reliability: 0.08, ersCharge: 0.03 },
      },
      {
        id: 'rs-ers',
        branchId: 'race',
        code: 'R-03',
        name: 'ERS Control Unit',
        desc: 'Harvest and deploy with race-control logic.',
        cost: 480,
        requires: 'rs-reliability',
        effects: { ersCharge: 0.07, ersBoost: 0.09, speed: 12 },
      },
    ],
  },
];

export const PROGRAMME_NODES = PROGRAMME_BRANCHES.flatMap((b) => b.nodes);

const NODE_BY_ID = Object.fromEntries(PROGRAMME_NODES.map((n) => [n.id, n]));

/** Old Development part id -> new programme node id */
export const DEV_TO_PROGRAMME = Object.freeze({
  'eng-intake': 'pt-intake',
  'eng-ecu': 'pt-ecu',
  'eng-internals': 'pt-unit',
  'eng-final-drive': 'pt-unit',
  'aero-front': 'ae-front',
  'aero-floor': 'ae-underbody',
  'aero-diffuser': 'ae-underbody',
  'aero-wing': 'ae-wing',
  'chassis-susp': 'ch-susp',
  'chassis-brakes': 'ch-brakes',
  'chassis-weight': 'ch-agile',
  'chassis-rack': 'ch-agile',
});

/** Old R&D node id -> new programme node id */
export const RND_TO_PROGRAMME = Object.freeze({
  'engine-intake': 'pt-intake',
  'engine-ecu': 'pt-ecu',
  'engine-internals': 'pt-unit',
  'engine-ice': 'rs-reliability',
  'chassis-geometry': 'ch-susp',
  'chassis-brakes': 'ch-brakes',
  'chassis-weight': 'ch-agile',
  'chassis-rack': 'ch-agile',
  'aero-canards': 'ae-front',
  'aero-floor': 'ae-underbody',
  'aero-diffuser': 'ae-underbody',
  'aero-wing': 'ae-wing',
  'tyres-temp': 'rs-tyres',
  'tyres-structure': 'rs-tyres',
  'tyres-compound': 'rs-tyres',
  'tyres-window': 'rs-tyres',
  'ers-harvest': 'rs-ers',
  'ers-deploy': 'rs-ers',
  'ers-cell': 'rs-ers',
  'ers-control': 'rs-ers',
  'rel-cooling': 'rs-reliability',
  'rel-sensors': 'rs-reliability',
  'rel-durability': 'rs-reliability',
  'rel-master': 'rs-reliability',
});

/** Known DEV research+implement costs (for spent/refund accounting). */
export const DEV_PART_COSTS = Object.freeze({
  'eng-intake': { research: 70, implement: 90 },
  'eng-ecu': { research: 110, implement: 140 },
  'eng-internals': { research: 170, implement: 220 },
  'eng-final-drive': { research: 210, implement: 260 },
  'aero-front': { research: 80, implement: 100 },
  'aero-floor': { research: 120, implement: 150 },
  'aero-diffuser': { research: 165, implement: 205 },
  'aero-wing': { research: 210, implement: 250 },
  'chassis-susp': { research: 75, implement: 95 },
  'chassis-brakes': { research: 105, implement: 130 },
  'chassis-weight': { research: 150, implement: 185 },
  'chassis-rack': { research: 185, implement: 225 },
});

/** Base R&D queue costs (attempt 0). */
export const RND_NODE_COSTS = Object.freeze({
  'engine-intake': 120,
  'engine-ecu': 210,
  'engine-internals': 360,
  'engine-ice': 520,
  'chassis-geometry': 110,
  'chassis-brakes': 220,
  'chassis-weight': 350,
  'chassis-rack': 540,
  'aero-canards': 120,
  'aero-floor': 240,
  'aero-diffuser': 380,
  'aero-wing': 560,
  'tyres-temp': 100,
  'tyres-structure': 210,
  'tyres-compound': 360,
  'tyres-window': 520,
  'ers-harvest': 130,
  'ers-deploy': 250,
  'ers-cell': 400,
  'ers-control': 560,
  'rel-cooling': 110,
  'rel-sensors': 220,
  'rel-durability': 360,
  'rel-master': 540,
});

export function getProgrammeNode(id) {
  return NODE_BY_ID[id] || null;
}

export function createEmptyProgrammeState() {
  return {
    schemaVersion: PROGRAMME_SCHEMA_VERSION,
    migrated: false,
    migrationRefund: 0,
    nodes: Object.fromEntries(PROGRAMME_NODES.map((n) => [n.id, false])),
  };
}

export function normalizeProgrammeState(raw) {
  const base = createEmptyProgrammeState();
  if (!raw || typeof raw !== 'object') return base;
  const nodes = { ...base.nodes };
  for (const id of Object.keys(nodes)) {
    const v = raw.nodes && raw.nodes[id];
    nodes[id] = v === true || v === 1 || v === '1';
  }
  return {
    schemaVersion: PROGRAMME_SCHEMA_VERSION,
    migrated: !!raw.migrated,
    migrationRefund: Math.max(0, Math.floor(Number(raw.migrationRefund) || 0)),
    nodes,
  };
}

export function isProgrammeNodeOwned(programme, nodeId) {
  const p = normalizeProgrammeState(programme);
  return !!p.nodes[nodeId];
}

export function canPurchaseProgrammeNode(programme, nodeId, coins) {
  const node = getProgrammeNode(nodeId);
  if (!node) return { ok: false, reason: 'unknown_node' };
  const p = normalizeProgrammeState(programme);
  if (p.nodes[node.id]) return { ok: false, reason: 'already_owned' };
  if (node.requires && !p.nodes[node.requires]) {
    return { ok: false, reason: 'missing_prereq', requires: node.requires };
  }
  if ((Number(coins) || 0) < node.cost) {
    return { ok: false, reason: 'insufficient_coins', cost: node.cost };
  }
  return { ok: true, cost: node.cost, node };
}

export function purchaseProgrammeNode(programme, nodeId, coins) {
  const check = canPurchaseProgrammeNode(programme, nodeId, coins);
  if (!check.ok) return { ok: false, reason: check.reason, programme: normalizeProgrammeState(programme), coins };
  const next = normalizeProgrammeState(programme);
  next.nodes[nodeId] = true;
  return {
    ok: true,
    programme: next,
    coins: (Number(coins) || 0) - check.cost,
    node: check.node,
  };
}

function emptyBonuses() {
  return {
    speed: 0,
    accel: 0,
    traction: 0,
    braking: 0,
    handling: 0,
    tyreWear: 0,
    reliability: 0,
    ersCharge: 0,
    ersBoost: 0,
  };
}

/** Sum effects from owned programme nodes. */
export function computeProgrammeBonuses(programme) {
  const p = normalizeProgrammeState(programme);
  const bonus = emptyBonuses();
  for (const node of PROGRAMME_NODES) {
    if (!p.nodes[node.id]) continue;
    const fx = node.effects || {};
    for (const key of Object.keys(fx)) {
      bonus[key] = (bonus[key] || 0) + (Number(fx[key]) || 0);
    }
  }
  return bonus;
}

/**
 * Tyre wear multiplier from programme durability effects.
 * Lower = less wear (matches prior R&D behaviour).
 */
export function computeProgrammeTyreWearMult(programme) {
  const b = computeProgrammeBonuses(programme);
  const raw = 1 - ((b.tyreWear || 0) + (b.reliability || 0));
  return Math.max(0.7, Math.min(1.08, raw));
}

/**
 * Compact export blob for OnlineSim / competitive upgrade claims.
 * Competitive mode still ignores this when TRUST_CLIENT_PROGRESSION_UPGRADES is false.
 */
export function exportProgrammeUpgradeStats(programme, setup = {}) {
  const b = computeProgrammeBonuses(programme);
  return {
    speed: b.speed || 0,
    accel: b.accel || 0,
    handling: b.handling || 0,
    braking: b.braking || 0,
    traction: b.traction || 0,
    speedMult: setup.speedMult != null ? setup.speedMult : 1,
    turnMult: setup.turnMult != null ? setup.turnMult : 1,
    brakeMult: setup.brakeMult != null ? setup.brakeMult : 1,
    tractBonus: setup.tractBonus != null ? setup.tractBonus : 0,
    tyreWearMult: computeProgrammeTyreWearMult(programme),
    ersCharge: b.ersCharge || 0,
    ersBoost: b.ersBoost || 0,
  };
}

function maxDevStage(p1dev, p2dev, partId) {
  const a = Math.max(0, Math.min(2, parseInt((p1dev && p1dev[partId]) || 0, 10) || 0));
  const b = Math.max(0, Math.min(2, parseInt((p2dev && p2dev[partId]) || 0, 10) || 0));
  return Math.max(a, b);
}

function rndSpendEstimate(nodeId, nodeState) {
  const base = RND_NODE_COSTS[nodeId] || 0;
  if (!nodeState || typeof nodeState !== 'object') return 0;
  const lastCost = Number(nodeState.lastCost);
  if (Number.isFinite(lastCost) && lastCost > 0) return Math.floor(lastCost);
  const attempts = Math.max(0, Math.floor(Number(nodeState.attempts) || 0));
  if (attempts <= 0 && nodeState.status === 'locked') return 0;
  if (nodeState.status === 'available' || nodeState.status === 'locked') return 0;
  // Queued / researching / complete / failed: at least one payment.
  const paidAttempts = Math.max(1, attempts);
  let total = 0;
  for (let i = 0; i < paidAttempts; i++) {
    total += Math.floor(base * (1 + i * 0.12));
  }
  return total;
}

/**
 * Migrate legacy Development + R&D into the unified programme.
 * Idempotent when programme.migrated is already true.
 *
 * @returns {{ programme: object, coins: number, refund: number, unlocked: string[], mapping: object }}
 */
export function migrateToProgramme(playerData) {
  const pd = playerData && typeof playerData === 'object' ? playerData : {};
  const existing = normalizeProgrammeState(pd.programme);
  if (existing.migrated) {
    return {
      programme: existing,
      coins: Number(pd.coins) || 0,
      refund: 0,
      unlocked: PROGRAMME_NODES.filter((n) => existing.nodes[n.id]).map((n) => n.id),
      mapping: {},
      alreadyMigrated: true,
    };
  }

  const unlocked = new Set();
  const mappingLog = {};
  let spent = 0;

  const p1dev = pd.p1dev || {};
  const p2dev = pd.p2dev || {};
  for (const [oldId, newId] of Object.entries(DEV_TO_PROGRAMME)) {
    const stage = maxDevStage(p1dev, p2dev, oldId);
    const costs = DEV_PART_COSTS[oldId] || { research: 0, implement: 0 };
    if (stage >= 1) spent += costs.research;
    if (stage >= 2) {
      spent += costs.implement;
      unlocked.add(newId);
      if (!mappingLog[oldId]) mappingLog[oldId] = { to: newId, via: 'dev', stage };
    } else if (stage === 1) {
      mappingLog[oldId] = { to: 'REFUND', via: 'dev_research_only', stage: 1 };
    }
  }

  const rnd = pd.rnd || pd.teamRnd || pd.research || null;
  const rndNodes = rnd && rnd.nodes && typeof rnd.nodes === 'object' ? rnd.nodes : {};
  for (const [oldId, newId] of Object.entries(RND_TO_PROGRAMME)) {
    const st = rndNodes[oldId];
    const status = st && st.status;
    const pay = rndSpendEstimate(oldId, st);
    if (pay > 0) spent += pay;
    if (status === 'complete') {
      unlocked.add(newId);
      mappingLog[oldId] = { to: newId, via: 'rnd', status };
    } else if (pay > 0) {
      mappingLog[oldId] = { to: 'REFUND', via: 'rnd_incomplete', status: status || 'unknown', spent: pay };
    }
  }

  // Honour prereqs: unlock implies all ancestors owned.
  const owned = Object.fromEntries(PROGRAMME_NODES.map((n) => [n.id, false]));
  for (const id of unlocked) {
    let cur = getProgrammeNode(id);
    const chain = [];
    while (cur) {
      chain.push(cur.id);
      cur = cur.requires ? getProgrammeNode(cur.requires) : null;
    }
    for (const cid of chain) owned[cid] = true;
  }

  let unlockCost = 0;
  for (const node of PROGRAMME_NODES) {
    if (owned[node.id]) unlockCost += node.cost;
  }

  const refund = Math.max(0, Math.floor(spent - unlockCost));
  const programme = {
    schemaVersion: PROGRAMME_SCHEMA_VERSION,
    migrated: true,
    migrationRefund: refund,
    nodes: owned,
  };

  return {
    programme,
    coins: (Number(pd.coins) || 0) + refund,
    refund,
    unlocked: PROGRAMME_NODES.filter((n) => owned[n.id]).map((n) => n.id),
    mapping: mappingLog,
    alreadyMigrated: false,
    spent,
    unlockCost,
  };
}

/**
 * Apply migration onto a player-data-like object (mutates copy).
 */
export function applyProgrammeMigration(playerData) {
  const pd = { ...(playerData || {}) };
  const result = migrateToProgramme(pd);
  pd.programme = result.programme;
  pd.coins = result.coins;
  return { playerData: pd, ...result };
}

export function formatProgrammeEffects(effects) {
  const e = effects || {};
  const tags = [];
  if (e.speed) tags.push(`+${Math.round(e.speed * 0.8)} KM/H`);
  if (e.accel) tags.push('+ACCEL');
  if (e.traction) tags.push(`+${Math.round(e.traction * 0.8)} GRIP`);
  if (e.braking) tags.push('+BRAKING');
  if (e.handling) tags.push(`+${Math.round(e.handling * 100)}% TURN`);
  if (e.tyreWear) tags.push('−WEAR');
  if (e.reliability) tags.push(e.reliability > 0 ? '+DURABILITY' : '−DURABILITY');
  if (e.ersCharge) tags.push('+ERS CHARGE');
  if (e.ersBoost) tags.push('+ERS BOOST');
  return tags.join(' · ');
}

export function programmeProgressCount(programme) {
  const p = normalizeProgrammeState(programme);
  const owned = PROGRAMME_NODES.filter((n) => p.nodes[n.id]).length;
  return { owned, total: PROGRAMME_NODES.length };
}

export default {
  PROGRAMME_SCHEMA_VERSION,
  PROGRAMME_BRANCHES,
  PROGRAMME_NODES,
  DEV_TO_PROGRAMME,
  RND_TO_PROGRAMME,
  getProgrammeNode,
  createEmptyProgrammeState,
  normalizeProgrammeState,
  isProgrammeNodeOwned,
  canPurchaseProgrammeNode,
  purchaseProgrammeNode,
  computeProgrammeBonuses,
  computeProgrammeTyreWearMult,
  exportProgrammeUpgradeStats,
  migrateToProgramme,
  applyProgrammeMigration,
  formatProgrammeEffects,
  programmeProgressCount,
};
