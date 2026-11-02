/** DAgger expert queries at learner-visited states, using the same real physics. */
import fs from 'node:fs';
import readline from 'node:readline';
import {Environment, officialTracks} from '../ml_training/official-worker-v2.mjs';
import {PHYSICS_HASH, geometry} from '../sim/official-policy.mjs';
import {observe} from '../sim/official-policy-v2.mjs';
import {makePlan, speedEnvelope, plannedAction} from '../sim/pace-planner.mjs';
const saved = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), track = officialTracks[saved.trackId];
const plan = makePlan(track, saved.parameters);
if (saved.physicsHash !== PHYSICS_HASH || saved.trackFingerprint !== plan.trackFingerprint || saved.profile.profileHash !== plan.profile.profileHash) throw Error('Coach plan differs from the current physics or track');
let env, speeds;
const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of rl) {
  try {
    const request = JSON.parse(line); let reply;
    if (request.command === 'reset') {
      const c = request.case;
      env = new Environment(0, {...c, trackId: track.id, difficulty: 'extreme', randomization: false, racecraft: false, lineGuidance: false, lineProfile: plan.profile, episodeSeconds: Math.max(150, c.raceLaps * 120)});
      let observation = env.reset({fixed: true, mode: c.mode, raceLaps: c.raceLaps, energy: c.energy});
      if (c.lateralOffset || c.headingOffset) {
        const angle = env.kart.angle;
        env.kart.x -= Math.sin(angle) * (c.lateralOffset || 0); env.kart.y += Math.cos(angle) * (c.lateralOffset || 0); env.kart.angle += c.headingOffset || 0;
        env.kart.prevX = env.kart.x; env.kart.prevY = env.kart.y; env.state.lastAngle = env.kart.angle;
        env.lastG = geometry(env.kart, env.track, env.state); env.trajectory = []; env.record(); observation = observe(env.kart, env.track, env.state, env.context);
      }
      speeds = speedEnvelope(plan, env.kart.maxSpeed, env.kart.brakeForce);
      reply = {observation, expert: plannedAction(env, plan, speeds)};
    } else if (request.command === 'step') {
      if (!env || !Array.isArray(request.action) || request.action.length !== 4 || request.action.some(x => !Number.isFinite(x) || Math.abs(x) > 1)) throw Error('Invalid coach action');
      const result = env.step(request.action);
      reply = {observation: result.observation, expert: plannedAction(env, plan, speeds), done: result.done, result: result.info};
    } else if (request.command === 'recording') reply = {points: env.trajectory};
    else if (request.command === 'close') { process.stdout.write(JSON.stringify({ok: true}) + '\n'); rl.close(); process.stdin.destroy(); break; }
    else throw Error('Unknown coach command');
    process.stdout.write(JSON.stringify({ok: true, ...reply}) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ok: false, error: error.stack || error.message}) + '\n'); }
}
