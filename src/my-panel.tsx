// src/my-panel.tsx
import * as React from "react";
import { useRozeniteDevToolsClient } from "@rozenite/plugin-bridge";

// Design tokens (dark theme)
const theme = {
  background: "#0b1220",
  surface: "#0f172a",
  surfaceAlt: "#0b1424",
  border: "#1f2937",
  text: "#e5e7eb",
  mutedText: "#94a3b8",
  primary: "#60a5fa",
  primarySoft: "#0b1a33",
  success: "#22c55e",
  warning: "#f59e0b",
  danger: "#ef4444",
  purple: "#a78bfa",
  cardShadow:
    "0 1px 2px rgba(0,0,0,.35), 0 8px 24px rgba(0,0,0,.25)",
};

type Commit = {
  timestamp?: number;
  duration: number;
  effectDuration?: number | null;
  passiveEffectDuration?: number | null;
  priority?: string;
  updaters?: { displayName?: string }[];
};

type ProfilerJSON = {
  dataForRoots?: { commitData?: Commit[]; displayName?: string }[];
  profilingStartTime?: number;
  profilingEndTime?: number;
  version?: number;
};

// Bridge event map
type PluginEvents = {
  "profiler-export": ProfilerJSON;
  "start-profiler": { hz: number };
  "stop-profiler": { hz: number };
  "fps-tick": { fps: number; jsStallsMs: number };
  "reset-profiler": {};
  "hermes-start": {};
  "hermes-stop": {};
  "hermes-profile": { path?: string; note?: string; error?: string };
  "hermes-check": {};
};

function parseCommits(json: ProfilerJSON): Commit[] {
  // Try common shapes; fall back to empty
  const roots = json?.dataForRoots ?? [];
  const first = roots[0];
  const commits = first?.commitData ?? [];
  return Array.isArray(commits) ? commits : [];
}

function ms(n?: number | null): string {
  if (typeof n !== "number") return "—";
  return `${n.toFixed(1)} ms`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function durationColor(duration: number, budget: number) {
  const ratio = duration / budget;
  if (ratio <= 0.6) return theme.success;
  if (ratio <= 1) return theme.warning;
  return theme.danger;
}

function priorityHue(priority?: string) {
  const p = (priority || "").toLowerCase();
  if (p.includes("immediate") || p.includes("high")) return theme.danger;
  if (p.includes("user") || p.includes("normal")) return theme.primary;
  if (p.includes("low") || p.includes("idle")) return theme.mutedText;
  return theme.mutedText;
}

export default function Panel() {
  const [profile, setProfile] = React.useState<ProfilerJSON | null>(null);
  const [hz, setHz] = React.useState<60 | 120>(60);
  const [isDragging, setIsDragging] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const client = useRozeniteDevToolsClient<PluginEvents>({ pluginId: "my-perf-flame" });
  const [isCapturing, setIsCapturing] = React.useState(false);
  const [fps, setFps] = React.useState<number | null>(null);
  const [stallsMs, setStallsMs] = React.useState<number | null>(null);
  const [bridgeReady, setBridgeReady] = React.useState(false);
  const [hermesStatus, setHermesStatus] = React.useState<string | null>(null);
  const [devtoolsProfilerReady, setDevtoolsProfilerReady] = React.useState(false);
  const [devtoolsProfiling, setDevtoolsProfiling] = React.useState(false);
  // Capture-session metrics to drive analytics after stop
  const [sessionWorstFps, setSessionWorstFps] = React.useState<number | null>(null);
  const [sessionStallTotalMs, setSessionStallTotalMs] = React.useState<number>(0);

  const budget = hz === 60 ? 16.7 : 8.3;

  const commits = React.useMemo(
    () => (profile ? parseCommits(profile) : []),
    [profile]
  );

  const stats = React.useMemo(() => {
    if (!commits.length) return null;
    let janky = 0;
    let worst: Commit | null = null;
    const updaterCounts = new Map<string, number>();
    const updaterWeighted = new Map<string, number>();
    const durations: number[] = [];
    let effectHeavy = 0;
    let passiveHeavy = 0;
    let maxPassive = 0;

    for (const c of commits) {
      if (!worst || c.duration > worst.duration) worst = c;
      if (c.duration > budget) janky++;
      durations.push(c.duration);
      if ((c.effectDuration ?? 0) > budget * 0.5) effectHeavy++;
      if ((c.passiveEffectDuration ?? 0) > budget * 0.5) passiveHeavy++;
      if ((c.passiveEffectDuration ?? 0) > maxPassive) maxPassive = c.passiveEffectDuration ?? 0;
      for (const u of c.updaters ?? []) {
        const name = u.displayName || "(anonymous)";
        updaterCounts.set(name, (updaterCounts.get(name) || 0) + 1);
        updaterWeighted.set(name, (updaterWeighted.get(name) || 0) + c.duration);
      }
    }
    const topUpdaters = [...updaterCounts.entries()]
      .filter(([name]) => name && name !== '(anonymous)')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const culpritsByDuration = [...updaterWeighted.entries()]
      .filter(([name]) => name && name !== '(anonymous)')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

    const jankRate = Math.round((janky / commits.length) * 100);

    // Key insights
    const sorted = [...durations].sort((a, b) => a - b);
    const n = sorted.length;
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const p95 = sorted[Math.floor(0.95 * (n - 1))];
    const avg = sorted.reduce((a, b) => a + b, 0) / Math.max(1, n);

    const windowMs = (profile?.profilingEndTime ?? 0) - (profile?.profilingStartTime ?? 0);
    const perMinute = windowMs > 0 ? Math.round((commits.length / windowMs) * 60000) : undefined;

    return {
      total: commits.length,
      janky,
      jankRate,
      worst: worst!,
      topUpdaters,
      avg,
      median,
      p95,
      culpritsByDuration,
      effectShare: Math.round((effectHeavy / commits.length) * 100),
      passiveShare: Math.round((passiveHeavy / commits.length) * 100),
      maxPassive,
      perMinute,
    };
  }, [commits, budget, profile]);

  const jankyCommits = React.useMemo(() => {
    return commits
      .map((c, i) => ({ ...c, idx: i }))
      .filter((c) => c.duration > budget)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 20);
  }, [commits, budget]);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result));
        setProfile(json);
      } catch (err) {
        alert("Invalid JSON file.");
      }
    };
    reader.readAsText(f);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(String(reader.result));
        setProfile(json);
      } catch (err) {
        alert("Invalid JSON file.");
      }
    };
    reader.readAsText(f);
  }

  // Live capture via plugin bridge
  // Ensure Hermes subscription is registered ASAP (before other UI state updates)
  React.useLayoutEffect(() => {
    if (!client) {
      console.log('[PerfFlame Panel] No client available');
      return;
    }
    console.log('[PerfFlame Panel] Client connected, setting up listeners');
    setBridgeReady(true);
    
    const sub = client.onMessage("profiler-export", (data) => {
      console.log('[PerfFlame Panel] Received profiler-export:', data);
      setProfile(data as unknown as ProfilerJSON);
    });
    
    const sub3 = client.onMessage("hermes-profile", (m) => {
      console.log('[PerfFlame Panel] Hermes profile message:', m);
      if (m.error) setHermesStatus(`Error: ${m.error}`);
      else if (m.path || m.note) setHermesStatus(`${m.path ? `Path: ${m.path} • ` : ''}${m.note ?? ''}`);
    });
    const sub4 = client.onMessage("devtools-profiler-state", (m: any) => {
      console.log('[PerfFlame Panel] DevTools profiler state:', m);
      if (m && typeof m.profiling === 'boolean') {
        setDevtoolsProfilerReady(!!m.ready);
        setDevtoolsProfiling(!!m.profiling);
      }
    });
    const sub2 = client.onMessage("fps-tick", (d) => {
      console.log('[PerfFlame Panel] Received fps-tick:', d);
      setFps(d.fps);
      setStallsMs(d.jsStallsMs);
      setSessionWorstFps((prev) => prev == null ? d.fps : Math.min(prev, d.fps));
      setSessionStallTotalMs((prev) => prev + (d.jsStallsMs || 0));
    });
    
    return () => {
      console.log('[PerfFlame Panel] Cleaning up listeners');
      sub.remove();
      sub3.remove();
      sub4.remove();
      sub2.remove();
    };
  }, [client]);

  // Auto-ingest React DevTools Profiler data when user records/stops in Profiler tab
  React.useEffect(() => {
    try {
      const ReactDevTools: any = (globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!ReactDevTools) return;
      const store = (ReactDevTools as any).profilerStore;
      if (!store || typeof store.getProfilingData !== 'function') return;
      setDevtoolsProfilerReady(true);
      let prev = !!store.isProfiling?.();
      setDevtoolsProfiling(prev);
      const timer = setInterval(() => {
        try {
          const now = !!store.isProfiling?.();
          if (now !== prev) {
            setDevtoolsProfiling(now);
            if (!now) {
              const data = store.getProfilingData?.();
              if (data) {
                console.log('[PerfFlame Panel] Ingesting DevTools profiling data');
                setProfile(data as ProfilerJSON);
              }
            }
            prev = now;
          }
        } catch {}
      }, 500);
      return () => clearInterval(timer);
    } catch {}
  }, []);

  function toggleCapture() {
    if (!client) {
      console.log('[PerfFlame Panel] No client available for toggleCapture');
      return;
    }
    
    const next = !isCapturing;
    console.log(`[PerfFlame Panel] Toggling capture: ${isCapturing} -> ${next}`);
    setIsCapturing(next);
    if (next) {
      // starting: reset session metrics
      setSessionWorstFps(null);
      setSessionStallTotalMs(0);
    }
    
    // Try to start/stop React DevTools profiler directly
    try {
      const ReactDevTools = (globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
      console.log('[PerfFlame Panel] React DevTools hook:', !!ReactDevTools);
      
      if (ReactDevTools && ReactDevTools.profilerStore) {
        console.log('[PerfFlame Panel] Found profilerStore, controlling directly');
        if (next) {
          ReactDevTools.profilerStore.startProfiling();
          console.log('[PerfFlame Panel] Started React DevTools profiling');
        } else {
          ReactDevTools.profilerStore.stopProfiling();
          console.log('[PerfFlame Panel] Stopped React DevTools profiling');
          // Get the profiler data directly
          const profilingData = ReactDevTools.profilerStore.getProfilingData();
          console.log('[PerfFlame Panel] Got profiling data:', profilingData);
          if (profilingData) {
            setProfile(profilingData as unknown as ProfilerJSON);
          }
        }
      } else {
        console.log('[PerfFlame Panel] No React DevTools profilerStore found');
      }
    } catch (e) {
      console.warn('[PerfFlame Panel] Could not control React DevTools profiler directly:', e);
    }
    
    console.log(`[PerfFlame Panel] Sending ${next ? "start-profiler" : "stop-profiler"} to bridge`);
    client.send(next ? "start-profiler" : "stop-profiler", { hz });
  }

  return (
    <div
      style={{
        padding: 16,
        fontFamily: "ui-sans-serif, system-ui",
        lineHeight: 1.35,
        background: theme.background,
        color: theme.text,
        height: "100%",
        maxHeight: "100vh",
        overflow: "auto",
      }}
    >
      <style>{`
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulseSoft { 0% { box-shadow: 0 0 0 0 rgba(59,130,246,.3);} 70% { box-shadow: 0 0 0 8px rgba(59,130,246,0);} 100% { box-shadow: 0 0 0 0 rgba(59,130,246,0);} }
        .card-enter { animation: fadeInUp .35s ease-out both; }
        .hover-rise { transition: transform .16s ease, box-shadow .16s ease; }
        .hover-rise:hover { transform: translateY(-2px); box-shadow: ${theme.cardShadow}; }
        .dropzone { border: 1.5px dashed ${theme.border}; border-radius: 12px; background: ${theme.surface}; transition: border-color .2s ease, background .2s ease; }
        .dropzone.drag { border-color: ${theme.primary}; background: ${theme.primarySoft}; }
        .badge { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; background:${theme.surfaceAlt}; border:1px solid ${theme.border}; }
        .table th { position: sticky; top: 0; background: ${theme.surface}; }
      `}</style>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h2 style={{ margin: 0, letterSpacing: -0.2 }}>Perf Flame</h2>
        <label style={{ fontSize: 12, opacity: 0.8 }}>
          Frame rate:&nbsp;
          <select
            value={hz}
            onChange={(e) => setHz(Number(e.target.value) as 60 | 120)}
            style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.surface, color: theme.text }}
          >
            <option value={60}>60 Hz (budget ~16.7ms)</option>
            <option value={120}>120 Hz (budget ~8.3ms)</option>
          </select>
        </label>
        <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={onFile} style={{ display: "none" }} />
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: `1px solid ${theme.border}`,
            background: theme.surface,
            cursor: "pointer",
            color: theme.text,
          }}
        >
          Upload JSON
        </button>
        {/* Live capture button removed per request */}
        {client && (
          <button
            onClick={() => {
              console.log('[PerfFlame Panel] Clearing state');
              setProfile(null);
              setFps(null);
              setStallsMs(null);
              setIsCapturing(false);
              setHermesStatus(null);
              try {
                client.send('reset-profiler', {} as any);
              } catch (e) {
                console.warn('[PerfFlame Panel] reset-profiler send failed:', e);
              }
            }}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: `1px solid ${theme.border}`,
              background: theme.surface,
              cursor: "pointer",
              color: theme.text,
            }}
          >
            Clear
          </button>
        )}
        <span className="badge" style={{ marginLeft: 8, color: bridgeReady ? theme.success : theme.mutedText }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: bridgeReady ? theme.success : theme.mutedText, display: "inline-block" }} />
          {bridgeReady ? "bridge: ready" : "bridge: offline"}
        </span>
        <span className="badge" style={{ marginLeft: 8, color: devtoolsProfilerReady ? theme.success : theme.mutedText }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: devtoolsProfiling ? theme.warning : (devtoolsProfilerReady ? theme.success : theme.mutedText), display: "inline-block" }} />
          {devtoolsProfiling ? 'devtools profiler: recording' : (devtoolsProfilerReady ? 'devtools profiler: ready' : 'devtools profiler: n/a')}
        </span>
        {isCapturing && (
          <span style={{ marginLeft: 8, fontSize: 12, color: theme.mutedText }}>
            {fps ? `${fps} fps` : ""}{stallsMs ? ` • stalls ${stallsMs}ms` : ""}
          </span>
        )}
        {!!hermesStatus && (
          <span className="badge" style={{ marginLeft: 8 }}>
            {hermesStatus}
          </span>
        )}
      </div>

      {!profile && (
        <>
          <div
            className={`dropzone ${isDragging ? "drag" : ""}`}
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(false);
            }}
            onDrop={onDrop}
            style={{ padding: 24, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8 }}
          >
            <div style={{ fontWeight: 700 }}>Drop profiler JSON here</div>
            <div style={{ fontSize: 12, color: theme.mutedText }}>
              or click "Upload JSON" to select a file
            </div>
          </div>
          <p style={{ opacity: 0.8, marginTop: 12 }}>
            Upload a <strong>React DevTools Profiler</strong> export (.json). We’ll
            visualize janky commits, worst offenders, and frequent updaters.
          </p>
        </>
      )}

      {stats && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: 12,
              marginTop: 8,
            }}
          >
            <Card className="card-enter hover-rise" title="Total commits" value={String(stats.total)} />
            <Card
              className="card-enter hover-rise"
              title="Janky commits"
              value={`${stats.janky} (${stats.jankRate}%)`}
            />
            <Card
              className="card-enter hover-rise"
              title="Worst commit"
              value={ms(stats.worst?.duration)}
              sub={ms(stats.worst?.passiveEffectDuration)}
              subLabel="passive"
            />
            <Card className="card-enter hover-rise" title="Budget" value={ms(budget)} sub={`${hz} Hz${stats.perMinute ? ` • ${stats.perMinute}/min` : ''}`} />
          </div>

          <Section title="Key insights">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
              <Card className="hover-rise" title="Average" value={ms(stats.avg)} />
              <Card className="hover-rise" title="Median" value={ms(stats.median)} />
              <Card className="hover-rise" title="P95" value={ms(stats.p95)} />
            </div>
          </Section>

          {/* Top culprit summary */}
          {!!(stats.culpritsByDuration as [string, number][]).length && (
            <Section title="Top culprit">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(1, minmax(0, 1fr))", gap: 12 }}>
                {(() => {
                  const [name, dur] = (stats.culpritsByDuration as [string, number][])[0];
                  return <Card className="hover-rise" title={name} value={ms(dur)} sub="heaviest total time" />;
                })()}
              </div>
            </Section>
          )}

          <Section title="Re-render hotspots">
            <Hotspots items={stats.topUpdaters} />
          </Section>

          <Section title="Culprits by total duration (heaviest impact)">
            <Hotspots items={stats.culpritsByDuration as [string, number][]} />
          </Section>

          <Section title="Janky commits (> budget)">
            <div
              style={{
                overflow: "auto",
                border: `1px solid ${theme.border}`,
                borderRadius: 8,
              }}
            >
              <table
                className="table"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr style={{ background: theme.surface }}>
                    <Th>#</Th>
                    <Th>Duration</Th>
                    <Th>Effects</Th>
                    <Th>Passive</Th>
                    <Th>Priority</Th>
                    <Th>Top updater</Th>
                    <Th>Over budget</Th>
                  </tr>
                </thead>
                <tbody>
                  {jankyCommits.map((c) => {
                    const topUpdater = c.updaters?.[0]?.displayName ?? "—";
                    return (
                      <CommitRow key={c.idx} c={c} budget={budget} />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Suggestions">
            <Suggestions stats={stats} budget={budget} metrics={{ worstFps: sessionWorstFps ?? undefined, stallTotalMs: sessionStallTotalMs }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginTop: 12 }}>
              <Card className="hover-rise" title="Effect-heavy commits" value={`${stats.effectShare}%`} />
              <Card className="hover-rise" title="Passive-heavy commits" value={`${stats.passiveShare}%`} />
              <Card className="hover-rise" title="Max passive" value={ms(stats.maxPassive)} />
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function Card(props: {
  title: string;
  value: string;
  sub?: string;
  subLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={props.className ?? ""}
      style={{
        border: `1px solid ${theme.border}`,
        borderRadius: 14,
        padding: 12,
        background: theme.surface,
      }}
    >
      <div style={{ fontSize: 12, color: theme.mutedText }}>{props.title}</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{props.value}</div>
      {props.sub && (
        <div style={{ fontSize: 12, color: theme.mutedText }}>
          {props.subLabel ? `${props.subLabel}: ` : ""}
          {props.sub}
        </div>
      )}
    </div>
  );
}
function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 16 }}>
      <h3 style={{ margin: "8px 0" }}>{props.title}</h3>
      {props.children}
    </section>
  );
}

function Th(props: { children: React.ReactNode }) {
  return (
    <th style={{ textAlign: "left", padding: "8px 10px", fontWeight: 600 }}>
      {props.children}
    </th>
  );
}
function Td(props: { children: React.ReactNode }) {
  return <td style={{ padding: "8px 10px" }}>{props.children}</td>;
}

function CommitRow(props: { c: Commit & { idx?: number }; budget: number }) {
  const { c, budget } = props;
  const [open, setOpen] = React.useState(false);
  const topUpdater = c.updaters?.[0]?.displayName ?? "—";
  const effect = c.effectDuration ?? 0;
  const passive = c.passiveEffectDuration ?? 0;
  const render = Math.max(0, c.duration - effect - passive);
  const total = Math.max(1e-6, render + effect + passive);
  const rPct = `${Math.round((render / total) * 100)}%`;
  const ePct = `${Math.round((effect / total) * 100)}%`;
  const pPct = `${Math.round((passive / total) * 100)}%`;
  return (
    <>
      <tr style={{ borderTop: `1px solid ${theme.border}`, cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <Td>{(c as any).idx}</Td>
        <Td>
          <span style={{ color: durationColor(c.duration, budget), fontWeight: 600 }}>
            {ms(c.duration)}
          </span>
        </Td>
        <Td>{ms(c.effectDuration)}</Td>
        <Td>{ms(c.passiveEffectDuration)}</Td>
        <Td>
          {c.priority ? (
            <span className="badge" style={{ color: priorityHue(c.priority) }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: priorityHue(c.priority), display: "inline-block" }} />
              {c.priority}
            </span>
          ) : (
            "—"
          )}
        </Td>
        <Td>
          <code>{topUpdater}</code>
        </Td>
        <Td>
          <MeterBar value={clamp(c.duration / budget, 0, 2)} />
        </Td>
      </tr>
      {open && (
        <tr style={{ borderTop: `1px solid ${theme.border}` }}>
          <td colSpan={7} style={{ padding: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ width: 140, height: 10, background: theme.surfaceAlt, border: `1px solid ${theme.border}`, borderRadius: 999, position: "relative" }}>
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: rPct, background: theme.primary, borderRadius: 999 }} />
                  <div style={{ position: "absolute", left: rPct, top: 0, bottom: 0, width: ePct, background: theme.warning, borderRadius: 0 }} />
                  <div style={{ position: "absolute", left: `calc(${rPct} + ${ePct})`, top: 0, bottom: 0, width: pPct, background: theme.danger, borderRadius: 0 }} />
                </div>
                <div style={{ fontSize: 12, color: theme.mutedText }}>render {rPct} • effects {ePct} • passive {pPct}</div>
              </div>
              <div style={{ fontSize: 12, color: theme.mutedText }}>Updaters:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {(c.updaters ?? []).map((u, i) => (
                  <span key={i} className="badge">
                    <code>{u.displayName ?? "(anonymous)"}</code>
                  </span>
                ))}
                {!(c.updaters ?? []).length && <span style={{ color: theme.mutedText }}>—</span>}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
function MeterBar(props: { value: number }) {
  const v = clamp(props.value, 0, 2); // 0..2x budget
  const pct = `${Math.min(100, v * 50)}%`; // 2x => 100%
  const color = v <= 0.6 ? theme.success : v <= 1 ? theme.warning : theme.danger;
  return (
    <div style={{ width: 140, height: 8, background: "#111827", borderRadius: 999, position: "relative" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: pct,
          background: color,
          borderRadius: 999,
          transition: "width .3s ease",
        }}
      />
    </div>
  );
}

function Hotspots(props: { items: [string, number][] }) {
  if (!props.items.length) return <div style={{ color: theme.mutedText }}>No hotspots detected.</div>;
  const max = Math.max(...props.items.map(([, count]) => count));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {props.items.map(([name, count]) => {
        const w = `${(count / max) * 100}%`;
        const color = count / max > 0.66 ? theme.danger : count / max > 0.33 ? theme.warning : theme.primary;
        return (
          <div key={name} style={{ display: "grid", gridTemplateColumns: "180px 1fr auto", alignItems: "center", gap: 8 }}>
            <code style={{ color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</code>
            <div style={{ height: 10, background: theme.surfaceAlt, border: `1px solid ${theme.border}`, borderRadius: 999, position: "relative" }}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: w, background: color, borderRadius: 999 }} />
            </div>
            <div style={{ fontSize: 12, color: theme.mutedText }}>{count}</div>
          </div>
        );
      })}
    </div>
  );
}

function Suggestions(props: { stats: { jankRate: number; worst: Commit; avg: number; p95: number; topUpdaters: [string, number][]; culpritsByDuration?: [string, number][] }; budget: number; metrics?: { worstFps?: number; stallTotalMs?: number } }) {
  const { stats, budget, metrics } = props;
  const items: string[] = [];
  if (stats.jankRate > 20) items.push("High jank rate: audit expensive renders; prefer memoization and virtualization.");
  if (stats.p95 > budget) items.push(`P95 exceeds budget (${ms(stats.p95)} > ${ms(budget)}): split work across frames and defer effects.`);
  if ((stats.worst.passiveEffectDuration || 0) > budget * 0.5)
    items.push("Large passive effects: move heavy logic out of effects or defer to Idle callbacks.");
  if (stats.avg > budget * 0.6) items.push("Average commit close to budget: consider UI-thread animations and reducing setState fan-out.");
  if (stats.topUpdaters.some(([n]) => n === "(anonymous)")) items.push("Anonymous updaters: name components/functions to track hotspots precisely.");
  if (metrics?.worstFps != null && metrics.worstFps < 50) items.push(`Low FPS observed (${metrics.worstFps}): move animations to UI thread and reduce JS work during interactions.`);
  if ((metrics?.stallTotalMs ?? 0) > 200) items.push(`JS thread stalls totaled ${ms(metrics?.stallTotalMs)}: debounce state updates and offload heavy sync work.`);
  if ((stats.culpritsByDuration ?? []).length) {
    const [name] = (stats.culpritsByDuration as [string, number][])[0];
    items.push(`Top culprit: ${name} – memoize props, split work, and avoid unnecessary renders.`);
  }
  if (!items.length) items.push("Looks healthy. Keep components pure and derived, and monitor P95 over time.");
  return (
    <ul style={{ margin: 0, paddingLeft: 16 }}>
      {items.map((s, i) => (
        <li key={i} style={{ color: theme.mutedText }}>{s}</li>
      ))}
    </ul>
  );
}
