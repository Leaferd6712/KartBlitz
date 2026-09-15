import { test, expect } from '@playwright/test';

test.describe('PartyServer integration', () => {
  test('real /version endpoint when the local worker is up', async ({ request }) => {
    const host = process.env.KARTBLITZ_PARTY_HOST || '127.0.0.1:8787';
    const url = `http://${host}/version`;
    let res;
    try {
      res = await request.get(url, { timeout: 2500 });
    } catch {
      test.skip(true, `PartyServer not reachable at ${host} (run: npm run party:dev)`);
      return;
    }
    if (!res.ok()) {
      test.skip(true, `PartyServer not reachable at ${host} (HTTP ${res.status()})`);
      return;
    }
    const body = await res.json();
    expect(body.protocol).toEqual(expect.any(Number));
    expect(body.trackBakeVersion).toEqual(expect.any(Number));
    expect(Array.isArray(body.tracks)).toBe(true);
    expect(body.tracks.length).toBeGreaterThan(0);
  });
});
