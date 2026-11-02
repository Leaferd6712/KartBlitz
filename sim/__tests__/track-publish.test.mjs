import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { trackSourceRanges, replaceTrackSource } from '../track-source.mjs';
import { extractTracks, bakeTrack } from '../../scripts/build/export-track-bakes.mjs';

const bundle = await build({ entryPoints: ['party/track-publish.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { handleTrackPublish, validatePublishedTrack } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const sourceBytes = Buffer.from(source);
const sourceSha = createHash('sha1').update(`blob ${sourceBytes.length}\0`).update(sourceBytes).digest('hex');
const originalTracks = JSON.parse(JSON.stringify(extractTracks(source)));
assert.ok(originalTracks.length >= 8);
const original = originalTracks[0];
const track = { ...original, racingLine: [{ x: 100, y: 200 }, { x: 250, y: 310 }, { x: 440, y: 200 }] };
const env = { LEADERBOARD_ADMIN_PASSWORD: 'test-admin', TRACK_PUBLISH_GITHUB_TOKEN: 'server-secret' };
const request = (overrides = {}, password = 'test-admin') => new Request('https://example.test/api/admin/tracks/publish', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
  body: JSON.stringify({ confirmed: true, sourceSha, track, ...overrides })
});
const forbiddenFetch = () => { throw Error('Must not contact GitHub'); };
assert.equal((await handleTrackPublish(request({}, 'wrong'), env, forbiddenFetch)).status, 401);
assert.equal((await handleTrackPublish(request(), { ...env, TRACK_PUBLISH_GITHUB_TOKEN: undefined }, forbiddenFetch)).status, 503);
assert.equal((await handleTrackPublish(request({ confirmed: false }), env, forbiddenFetch)).status, 400);
assert.equal((await handleTrackPublish(request({ sourceSha: 'bad' }), env, forbiddenFetch)).status, 400);
assert.equal((await handleTrackPublish(request({ track: { ...track, waypoints: [] } }), env, forbiddenFetch)).status, 400);
assert.equal((await handleTrackPublish(request({ track: { ...track, name: '<img src=x onerror=alert(1)>' } }), env, forbiddenFetch)).status, 400);
assert.throws(() => validatePublishedTrack({ ...track, authoredWaypoints: [] }));
assert.throws(() => validatePublishedTrack({ ...track, cpFracs: [0, -1, 3] }));
assert.throws(() => validatePublishedTrack({ ...track, pitLane: { ...track.pitLane, width: -1 } }));
assert.throws(() => validatePublishedTrack({ ...track, startPos: { x: null, y: 1 } }));

const calls = [];
const github = async (url, options) => {
  calls.push({ url, options });
  assert.equal(options.headers.Authorization, 'Bearer server-secret');
  if (options.method !== 'PUT') return Response.json({ sha: sourceSha, encoding: 'base64', content: sourceBytes.toString('base64') });
  const body = JSON.parse(options.body);
  assert.equal(body.sha, sourceSha);
  assert.equal(body.branch, 'main');
  const saved = Buffer.from(body.content, 'base64').toString('utf8');
  const savedTracks = JSON.parse(JSON.stringify(extractTracks(saved)));
  assert.deepEqual(savedTracks[0].racingLine, track.racingLine);
  assert.deepEqual(savedTracks.slice(1), originalTracks.slice(1), 'Other tracks remain untouched');
  const before = trackSourceRanges(source), after = trackSourceRanges(saved);
  assert.equal(source.slice(before.arrayEnd + 1), saved.slice(after.arrayEnd + 1), 'Game code remains untouched');
  const bake = bakeTrack(savedTracks[0]);
  assert.ok(bake.spline.length > 0);
  assert.equal(bake.drsZones.length, track.drsFracs.length, 'All DRS zones survive publishing');
  return Response.json({ commit: { sha: 'b'.repeat(40), html_url: 'https://github.com/Leaferd6712/KartBlitz/commit/' + 'b'.repeat(40) } });
};
const result = await handleTrackPublish(request(), env, github);
assert.equal(result.status, 202);
assert.equal((await result.json()).status, 'deployment_queued');
assert.equal(calls.length, 2);
assert.ok(calls.every(call => call.url.startsWith('https://api.github.com/repos/Leaferd6712/KartBlitz/contents/index.html')));

let writes = 0;
const conflict = await handleTrackPublish(request(), env, async (_url, options) => {
  if (options.method === 'PUT') writes++;
  return Response.json({ sha: 'c'.repeat(40), encoding: 'base64', content: sourceBytes.toString('base64') });
});
assert.equal(conflict.status, 409);
assert.equal(writes, 0, 'Stale editor cannot overwrite newer source');
const raced = await handleTrackPublish(request(), env, async (url, options) =>
  options.method === 'PUT' ? new Response(null, { status: 409 }) : github(url, options));
assert.equal(raced.status, 409, 'Concurrent GitHub update is reported safely');
const rejected = await handleTrackPublish(request(), env, async (url, options) =>
  options.method === 'PUT' ? new Response(null, { status: 403 }) : github(url, options));
assert.equal(rejected.status, 502);

const appended = replaceTrackSource(source, { ...original, id: originalTracks.length, name: 'NEW TRACK' });
assert.equal(extractTracks(appended).length, originalTracks.length + 1);
assert.throws(() => replaceTrackSource(source, { ...original, id: 12 }));
const escaped = replaceTrackSource(source, { ...original, name: '</script> & " Unicode 🏎' });
assert.equal(extractTracks(escaped)[0].name, '</script> & " Unicode 🏎');
assert.ok(!escaped.includes('"name": "</script>'));
assert.throws(() => trackSourceRanges('const TRACKS = [{id:0, name:`dynamic`}];'));
console.log('Track publishing: authorization, validation, source isolation, conflicts, encoding and online bakes passed.');
