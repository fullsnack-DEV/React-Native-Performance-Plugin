# RN Perf Lab – Perf Flame (v0.1.0)

Professional-grade performance analysis for React Native, embedded directly in React Native DevTools via Rozenite.

## What is this?

Perf Flame is a Rozenite DevTools plugin that makes react performance data easy to understand:

- Re-render hotspots by component name
- Culprits ranked by total time (heaviest impact)
- Janky commits table with render/effects/passive breakdowns
- Session insights (avg/median/P95, worst commit, budget awareness)
- Live FPS/stall telemetry during capture

Version: `v0.1.0` (early developer preview)

Roadmap: automatic ingestion from the DevTools Profiler tab and optional Hermes sampling flamegraphs (no manual export).

## Screenshots

Place your images under `docs/images/` (this repo includes the folder). Example references:

![Perf Flame – Demo](docs/images/Demo.png)

## Quick start

1) Install dependencies and start the host app in Dev Mode so Rozenite loads the plugin.

```bash
cd host-app
yarn
ROZENITE_DEV_MODE=my-perf-flame npx expo start -c
```

2) Build the plugin once (incremental rebuilds are fast).

```bash
cd host-app/plugins/my-perf-flame
npx rozenite build
```

3) Open React Native DevTools (press `j` in Expo terminal) → “Perf Flame”.

## Using Perf Flame

- Import a React DevTools Profiler JSON: click “Upload JSON” or drag-and-drop
- View hotspots, culprits, and commit details; expand rows to see render/effects/passive composition
- “Clear” resets the view for a new reading

Experimental (behind vendor hooks):
- Auto-ingest on Profiler stop (no export). When enabled, the badge will show “devtools profiler: ready/recording”

## Development

- Plugin source: `host-app/plugins/my-perf-flame/src/my-panel.tsx`
- React Native bridge: `host-app/plugins/my-perf-flame/react-native.ts`
- Rozenite config: `host-app/plugins/my-perf-flame/rozenite.config.ts`

Build the plugin:

```bash
cd host-app/plugins/my-perf-flame
npx rozenite build
```

Serve DevTools with Rozenite (from `host-app`):

```bash
ROZENITE_DEV_MODE=my-perf-flame npx expo start -c
```

## Vision / Roadmap

- v0.2: Auto-ingest from DevTools Profiler stop (no JSON), configurable budgets
- v0.3: Hermes sampling flamegraphs (one-click record/stop) and symbol mapping
- v0.4: Component drill-down with prop diffing and memoization suggestions

## Tech

- React Native + Expo (RN 0.79)
- Rozenite DevTools Framework ([repo](https://github.com/callstackincubator/rozenite))

## License

MIT


