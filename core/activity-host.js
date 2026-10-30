/** Small, framework-free lifecycle shared by the game and future activities. */
export function scopedStorage(id, storage = globalThis.localStorage) {
  const prefix = `kartblitz.activity.${id}.`;
  return Object.freeze({
    get(key, fallback = null) { try { const value = storage.getItem(prefix + key); return value === null ? fallback : JSON.parse(value); } catch { return fallback; } },
    set(key, value) { try { storage.setItem(prefix + key, JSON.stringify(value)); return true; } catch { return false; } },
    remove(key) { try { storage.removeItem(prefix + key); } catch {} }
  });
}

export function createActivityHost({ storage = globalThis.localStorage, now = () => performance.now() } = {}) {
  const activities = new Map();
  const events = new EventTarget();
  let current = null;
  let pending = Promise.resolve();
  const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail: { ...detail, time: now() } }));
  const enqueue = task => { const result = pending.then(task); pending = result.catch(() => {}); return result; };
  async function stop() {
    const previous = current;
    if (!previous) return;
    current = null;
    previous.controller.abort();
    try { await previous.activity.dispose?.(previous.context); }
    finally { for (const cleanup of previous.cleanups) { try { cleanup(); } catch {} } emit('activity:stop', { id: previous.activity.id }); }
  }
  return Object.freeze({
    events,
    register(activity) {
      if (!activity || !/^[a-z][a-z0-9-]*$/.test(activity.id) || typeof activity.start !== 'function') throw new TypeError('An activity needs a stable id and start function');
      if (activities.has(activity.id)) throw new Error(`Activity already registered: ${activity.id}`);
      activities.set(activity.id, Object.freeze({ ...activity }));
    },
    list: () => [...activities.values()].map(({ id, title }) => ({ id, title })),
    get active() { return current?.activity.id ?? null; },
    start(id, options = {}) { return enqueue(async () => {
      const activity = activities.get(id);
      if (!activity) throw new Error(`Unknown activity: ${id}`);
      await stop();
      const controller = new AbortController();
      const cleanups = new Set();
      const context = Object.freeze({ signal: controller.signal, storage: scopedStorage(id, storage), now, events,
        own(cleanup) { if (typeof cleanup !== 'function') throw new TypeError('Cleanup must be a function'); cleanups.add(cleanup); return cleanup; },
        emit: (type, detail = {}) => emit(type, { ...detail, activityId: id }) });
      current = { activity, controller, context, cleanups, paused: false };
      try { await activity.start(context, options); emit('activity:start', { id }); }
      catch (error) { await stop(); throw error; }
    }); },
    pause() { return enqueue(async () => { if (current && !current.paused) { await current.activity.pause?.(current.context); current.paused = true; emit('activity:pause', { id: current.activity.id }); } }); },
    resume() { return enqueue(async () => { if (current?.paused) { await current.activity.resume?.(current.context); current.paused = false; emit('activity:resume', { id: current.activity.id }); } }); },
    stop: () => enqueue(stop)
  });
}
