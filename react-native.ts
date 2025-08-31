import type { DevToolsPluginClient } from '@rozenite/plugin-bridge';
import { getRozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import { NativeModules } from 'react-native';

console.log('[PerfFlame Bridge] React Native bridge file loaded!');

type PluginEvents = {
  'profiler-export': any;
  'start-profiler': { hz: number };
  'stop-profiler': { hz: number };
  'fps-tick': { fps: number; jsStallsMs: number };
  'reset-profiler': {};
  'hermes-start': {};
  'hermes-stop': {};
  'hermes-profile': { path?: string; note?: string; error?: string };
  'hermes-check': {};
};

export default function setupPlugin(client: DevToolsPluginClient<PluginEvents>) {
  console.log('[PerfFlame Bridge] Plugin bridge initialized');
  console.log('[PerfFlame Bridge] Client object:', !!client);
  console.log('[PerfFlame Bridge] Client methods:', Object.keys(client || {}));
  let capturing = false;
  let timer: any;
  let fpsTimer: any;
  let lastTick = Date.now();
  let stallAccum = 0;
  let usedHook = false;
  let lastHookPayload: any = null;
  
  // Hook into React DevTools profiler if available
  const tryHookProfiler = () => {
    try {
      console.log('[PerfFlame Bridge] Trying to hook into React DevTools profiler');
      // Check if React DevTools profiler is available
      const ReactDevTools = (globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
      console.log('[PerfFlame Bridge] React DevTools hook found:', !!ReactDevTools);
      
      if (ReactDevTools && ReactDevTools.onCommitFiberRoot) {
        console.log('[PerfFlame Bridge] Found onCommitFiberRoot, hooking in');
        const originalOnCommit = ReactDevTools.onCommitFiberRoot;
        ReactDevTools.onCommitFiberRoot = (id: any, root: any, priorityLevel: any) => {
          if (capturing && root && root.current) {
            console.log('[PerfFlame Bridge] Capturing commit data from fiber root');
            // Extract profiler data from React DevTools
            const profilerData = extractProfilerData(root);
            if (profilerData) {
              console.log('[PerfFlame Bridge] Sending profiler data:', profilerData);
              lastHookPayload = profilerData;
              client.send('profiler-export', profilerData);
            }
          }
          return originalOnCommit?.(id, root, priorityLevel);
        };
        console.log('[PerfFlame Bridge] Successfully hooked into React DevTools');
        usedHook = true;
        return true;
      } else {
        console.log('[PerfFlame Bridge] No onCommitFiberRoot found');
      }
    } catch (e) {
      console.warn('[PerfFlame Bridge] Could not hook into React DevTools profiler:', e);
    }
    return false;
  };
  
  const extractProfilerData = (root: any) => {
    try {
      // Try to extract profiler data from React fiber tree
      const commits: any[] = [];
      const traverseFiber = (fiber: any, depth = 0) => {
        if (!fiber) return;
        
        if (fiber.actualDuration !== undefined) {
          commits.push({
            timestamp: Date.now(),
            duration: fiber.actualDuration,
            effectDuration: fiber.effectDuration || 0,
            passiveEffectDuration: fiber.passiveEffectDuration || 0,
            priority: fiber.lanes ? `Lane-${fiber.lanes}` : undefined,
            updaters: fiber.elementType?.displayName ? [{ displayName: fiber.elementType.displayName }] : []
          });
        }
        
        traverseFiber(fiber.child, depth + 1);
        traverseFiber(fiber.sibling, depth);
      };
      
      traverseFiber(root.current);
      
      if (commits.length > 0) {
        return {
          version: 4,
          profilingStartTime: Date.now() - 5000,
          profilingEndTime: Date.now(),
          dataForRoots: [{
            displayName: 'App',
            commitData: commits
          }]
        };
      }
    } catch (e) {
      console.warn('Error extracting profiler data:', e);
    }
    return null;
  };

  console.log('[PerfFlame Bridge] Setting up message handlers...');
  client.onMessage('start-profiler', (data) => {
    console.log('[PerfFlame Bridge] Received start-profiler message:', data);
    if (capturing) {
      console.log('[PerfFlame Bridge] Already capturing, ignoring');
      return;
    }
    capturing = true;
    (globalThis as any).__perfFlameCapture = true;
    console.log('[PerfFlame Bridge] Starting capture');
    
    // Hook into React DevTools profiler, but also run a light fallback poller to ensure data flows
    const hooked = tryHookProfiler();
    // Start background fallback polling regardless, to avoid empty streams on some RN/devtools combos
    timer = setInterval(async () => {
      if (!capturing) return;
      try {
        const payload = (NativeModules as any)?.PerfFlame?.export?.() ?? (globalThis as any).__perfFlameExport?.();
        if (payload) {
          console.log('[PerfFlame Bridge] Sending fallback profiler data:', payload);
          client.send('profiler-export', payload);
        }
      } catch (e) {
        console.warn('[PerfFlame Bridge] Error in fallback polling:', e);
      }
    }, 1500);

    // Simple JS FPS/stall estimator inspired by common RN practices
    const raf = () => {
      if (!capturing) return;
      const now = Date.now();
      const dt = now - lastTick;
      lastTick = now;
      if (dt > 50) stallAccum += dt - 16; // accumulated stall beyond budget
      fpsTimer = setTimeout(raf, 16);
    };
    lastTick = Date.now();
    stallAccum = 0;
    raf();

    // Emit FPS every second
    const emit = setInterval(() => {
      if (!capturing) return;
      const fps = 1000 / Math.max(16, Date.now() - lastTick);
      const fpsData = { fps: Math.round(fps), jsStallsMs: Math.round(stallAccum) };
      console.log('[PerfFlame Bridge] Sending fps-tick:', fpsData);
      client.send('fps-tick', fpsData);
      stallAccum = 0;
    }, 1000);
    (client as any).__perfFlameStopEmit = () => clearInterval(emit);
  });

  client.onMessage('stop-profiler', (data) => {
    console.log('[PerfFlame Bridge] Received stop-profiler message:', data);
    capturing = false;
    (globalThis as any).__perfFlameCapture = false;
    console.log('[PerfFlame Bridge] Stopping capture');
    
    if (timer) {
      console.log('[PerfFlame Bridge] Clearing polling timer');
      clearInterval(timer);
    }
    if (fpsTimer) {
      console.log('[PerfFlame Bridge] Clearing FPS timer');
      clearTimeout(fpsTimer);
    }
    (client as any).__perfFlameStopEmit?.();
    
    // Prefer the last hook-derived payload if available to preserve updaters
    if (usedHook && lastHookPayload) {
      console.log('[PerfFlame Bridge] Sending final hook-derived profiler data');
      client.send('profiler-export', lastHookPayload);
    } else {
      try {
        const payload = (NativeModules as any)?.PerfFlame?.export?.() ?? (globalThis as any).__perfFlameExport?.();
        if (payload) {
          console.log('[PerfFlame Bridge] Sending final profiler data on stop (fallback):', payload);
          client.send('profiler-export', payload);
        } else {
          console.log('[PerfFlame Bridge] No final profiler data available');
        }
      } catch (e) {
        console.warn('[PerfFlame Bridge] Error getting final profiler data:', e);
      }
    }

    // Reset session flags
    usedHook = false;
    lastHookPayload = null;
  });

  client.onMessage('reset-profiler', () => {
    console.log('[PerfFlame Bridge] Received reset-profiler message');
    capturing = false;
    (globalThis as any).__perfFlameCapture = false;
    if (timer) clearInterval(timer);
    if (fpsTimer) clearTimeout(fpsTimer);
    (client as any).__perfFlameStopEmit?.();
  });

  // Hermes sampling profiler controls (beta)
  client.onMessage('hermes-start', () => {
    console.log('[PerfFlame Bridge] Received hermes-start');
    try {
      const HI = (globalThis as any).HermesInternal;
      const HS = (globalThis as any).HermesSamplingProfiler;
      const enableFn = (HS && typeof HS.enable === 'function')
        ? () => HS.enable()
        : (HI && typeof HI.enableSamplingProfiler === 'function')
          ? () => HI.enableSamplingProfiler()
          : null;
      if (!enableFn) {
        client.send('hermes-profile', { error: 'Hermes profiler API not available in JS. Use Dev Menu: Enable Sampling Profiler.' });
        return;
      }
      enableFn();
      client.send('hermes-profile', { note: 'Hermes sampling profiler enabled. Reproduce the issue, then stop.' });
    } catch (e: any) {
      client.send('hermes-profile', { error: String(e?.message || e) });
    }
  });

  client.onMessage('hermes-stop', () => {
    console.log('[PerfFlame Bridge] Received hermes-stop');
    try {
      const HI = (globalThis as any).HermesInternal;
      const HS = (globalThis as any).HermesSamplingProfiler;
      const disableFn = (HS && typeof HS.disable === 'function')
        ? () => HS.disable()
        : (HI && typeof HI.disableSamplingProfiler === 'function')
          ? () => HI.disableSamplingProfiler()
          : null;
      if (!disableFn) {
        client.send('hermes-profile', { error: 'Hermes profiler API not available in JS. Use Dev Menu: Disable Sampling Profiler, then run: npx react-native profile-hermes' });
        return;
      }
      disableFn();
      let path: string | undefined;
      try {
        const dumpFn = (HI && typeof HI.dumpSampledTraceToFile === 'function') ? HI.dumpSampledTraceToFile
          : (HS && typeof HS.dumpSampledTraceToFile === 'function') ? HS.dumpSampledTraceToFile
          : null;
        if (dumpFn) {
          // Some RN versions accept a basename and return true; others return the path. Try both.
          const res = dumpFn('hermes-sampling');
          if (typeof res === 'string') path = res;
        }
      } catch (_e) {}
      const note = !path
        ? 'Profile saved on device. Run: npx react-native profile-hermes'
        : 'Profile path captured. You can pull/transform via CLI.';
      client.send('hermes-profile', { path, note });
    } catch (e: any) {
      client.send('hermes-profile', { error: String(e?.message || e) });
    }
  });

  client.onMessage('hermes-check', () => {
    try {
      const HI = (globalThis as any).HermesInternal;
      const HS = (globalThis as any).HermesSamplingProfiler;
      const methodsHI = HI ? Object.getOwnPropertyNames(HI).filter(k => typeof HI[k] === 'function') : [];
      const methodsHS = HS ? Object.getOwnPropertyNames(HS).filter(k => typeof HS[k] === 'function') : [];
      const flags = { __DEV__: (globalThis as any).__DEV__, engine: (globalThis as any).HermesInternal ? 'hermes' : 'unknown' };
      client.send('hermes-profile', { note: `HermesInternal: ${!!HI}; HermesSamplingProfiler: ${!!HS}; HI methods: ${methodsHI.join(', ')}; HS methods: ${methodsHS.join(', ')}; flags: ${JSON.stringify(flags)}` });
    } catch (e: any) {
      client.send('hermes-profile', { error: String(e?.message || e) });
    }
  });
}


// Ensure the bridge self-initializes a client so it can receive messages from the panel
(async () => {
  try {
    console.log('[PerfFlame Bridge] Bootstrapping Rozenite client...');
    const client = await getRozeniteDevToolsClient('my-perf-flame');
    if (client) {
      console.log('[PerfFlame Bridge] Rozenite client obtained, wiring plugin');
      setupPlugin(client as DevToolsPluginClient<PluginEvents>);
    } else {
      console.warn('[PerfFlame Bridge] Rozenite client not available');
    }
  } catch (e) {
    console.warn('[PerfFlame Bridge] Failed to bootstrap Rozenite client:', e);
  }
})();




