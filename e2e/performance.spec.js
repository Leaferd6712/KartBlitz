import {
  test,
  expect,
  gotoGame,
  dismissOnboarding,
  waitForMenu,
  startTimeTrial,
  confirmStartTyres,
  skipCountdown,
} from './fixtures/game.js';

const sampleMs = Number(process.env.KARTBLITZ_PERF_SAMPLE_MS || 6000);
const externalBase = String(process.env.KARTBLITZ_PERF_BASE_URL || '').replace(/\/$/, '');
const backendEnabled = process.env.KARTBLITZ_PERF_BACKEND === '1';

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

test('gameplay performance telemetry and hot-path network audit', async ({ page }, testInfo) => {
  const requests = [];
  let measuring = false;
  page.on('request', (request) => {
    if (measuring) requests.push(request.url());
  });

  const query = backendEnabled ? '?backend=http://127.0.0.1:65534' : '';
  await gotoGame(page, { path: externalBase ? `${externalBase}/${query}` : `/${query}` });
  await dismissOnboarding(page);
  await waitForMenu(page);
  await startTimeTrial(page);
  await confirmStartTyres(page, /MED/);
  await skipCountdown(page);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const beforeMetrics = await cdp.send('Performance.getMetrics');
  const taskBefore = beforeMetrics.metrics.find((item) => item.name === 'TaskDuration')?.value || 0;
  const heapBefore = await page.evaluate(() => performance.memory?.usedJSHeapSize || null);

  measuring = true;
  await page.keyboard.down('w');
  const raw = await page.evaluate(async (durationMs) => {
    const intervals = [];
    const longTasks = [];
    const start = performance.now();
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime >= start) longTasks.push(entry.duration);
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch (_) {}

    let previous = start;
    await new Promise((resolve) => {
      function frame(now) {
        intervals.push(now - previous);
        previous = now;
        if (now - start >= durationMs) resolve();
        else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    if (observer) observer.disconnect();

    const inputToFrame = [];
    for (let index = 0; index < 12; index++) {
      const inputAt = performance.now();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: index % 2 ? 'a' : 'd', bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame((paintAt) => {
        inputToFrame.push(paintAt - inputAt);
        resolve();
      }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: index % 2 ? 'a' : 'd', bubbles: true }));
    }
    return { intervals: intervals.slice(1), longTasks, inputToFrame };
  }, sampleMs);
  await page.keyboard.up('w');
  measuring = false;

  const afterMetrics = await cdp.send('Performance.getMetrics');
  const taskAfter = afterMetrics.metrics.find((item) => item.name === 'TaskDuration')?.value || 0;
  const heapAfter = await page.evaluate(() => performance.memory?.usedJSHeapSize || null);
  const sortedFrames = raw.intervals.slice().sort((a, b) => a - b);
  const sortedInputs = raw.inputToFrame.slice().sort((a, b) => a - b);
  const meanFrameMs = raw.intervals.reduce((sum, value) => sum + value, 0) / raw.intervals.length;
  const p95FrameMs = percentile(sortedFrames, 0.95);
  const metrics = {
    label: process.env.KARTBLITZ_PERF_LABEL || (backendEnabled ? 'python-configured' : 'current'),
    sampleMs,
    frameCount: raw.intervals.length,
    averageFps: Number((1000 / meanFrameMs).toFixed(2)),
    lowPercentileFps: Number((1000 / p95FrameMs).toFixed(2)),
    p95FrameMs: Number(p95FrameMs.toFixed(2)),
    p99FrameMs: Number(percentile(sortedFrames, 0.99).toFixed(2)),
    framesOver33Ms: raw.intervals.filter((value) => value > 33.33).length,
    longTaskCount: raw.longTasks.length,
    longestTaskMs: Number((Math.max(0, ...raw.longTasks)).toFixed(2)),
    p95InputToFrameMs: Number(percentile(sortedInputs, 0.95).toFixed(2)),
    javascriptTaskMs: Number(((taskAfter - taskBefore) * 1000).toFixed(2)),
    activeNetworkRequests: requests.length,
    activePythonRequests: requests.filter((url) => url.includes('127.0.0.1:65534')).length,
    heapBeforeBytes: heapBefore,
    heapAfterBytes: heapAfter,
    heapDeltaBytes: heapBefore == null || heapAfter == null ? null : heapAfter - heapBefore,
  };

  console.log(`KARTBLITZ_PERF ${JSON.stringify(metrics)}`);
  await testInfo.attach('gameplay-performance.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });

  expect(metrics.frameCount).toBeGreaterThan(60);
  expect(metrics.averageFps).toBeGreaterThan(30);
  expect(metrics.activePythonRequests).toBe(0);
  expect(metrics.activeNetworkRequests).toBe(0);
});
