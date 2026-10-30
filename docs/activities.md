# A foundation for future STEM activities

KartBLitz currently ships one activity: racing. There are no reaction-time games, classroom dashboards or experimental scoring modes in this change.

`core/activity-host.js` provides a small, framework-free boundary for future activities to share the browser and Windows shell without copying the racing engine. `core/shell.js` registers the existing engine through an adapter; it does not rewrite the physics or save format.

## Activity contract

Register an object with a unique lowercase `id`, a `title`, and `start(context, options)`. Optional methods are `pause(context)`, `resume(context)` and `dispose(context)`. `KartBlitzActivities.list()` supplies menu metadata when a future activity selector is needed. Do not put placeholder games in the current menu.

The start context supplies:

- `signal`: an AbortSignal, aborted before disposal. Use it for input listeners and pending asynchronous work.
- `own(cleanup)`: registers cleanup functions for animation frames, timers, audio and DOM nodes. They run even after a failed start.
- `storage`: JSON get/set/remove methods under `kartblitz.activity.<id>.`. Each activity has a separate namespace; the legacy race save remains unchanged.
- `now()`: monotonic `performance.now()` by default. Future timing experiments can inject a clock into a test host without altering racing.
- `emit(type, detail)` and `events`: activity events with an activity id and timestamp. The host also emits `activity:start`, `activity:pause`, `activity:resume` and `activity:stop`.

Starts, stops, pauses and resumes run through a queue. Starting another activity aborts and disposes the current one before starting the next. Cleanup functions should be synchronous; asynchronous disposal belongs in `dispose()`.

## Adding a future mini-game

1. Put the activity in its own directory with its own state, presentation and scoring. Import shared theme assets from `ui/`; avoid reading race globals.
2. Implement the lifecycle contract. Keep input handlers inside `start()` and register their cleanup. Stop timers and audio during pause/dispose.
3. Register it in `core/shell.js`; add its metadata to `core/game-manifest.json` when it is ready to ship.
4. Add its runtime files to `scripts/prepare-game.mjs`. The website and Electron build consume this same manifest.
5. Add a real menu choice and tests only when the activity is implemented. Test switching back to racing so no listeners, timers or scores leak across activities.

For a later reaction-time experiment, document units, timing methodology, input-device limits and accessibility before exposing results to students. The host provides timing and lifecycle primitives; it does not yet provide an experimental protocol or claim laboratory precision.

Run `npm run test:activities` for lifecycle ordering, failed-start cleanup, storage isolation and desktop asset boundaries. `core/activity-host.test.mjs` uses tiny test doubles rather than shipping example mini-games.
