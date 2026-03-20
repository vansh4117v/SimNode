#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

// ── helpers ────────────────────────────────────────────────────────────────

/** Parse a human duration string like "5m", "30s", "1h" into milliseconds. */
function parseDuration(s: string): number {
  const n = parseFloat(s);
  if (s.endsWith('h'))  return n * 3_600_000;
  if (s.endsWith('m'))  return n *    60_000;
  if (s.endsWith('s'))  return n *     1_000;
  return n; // bare number treated as ms
}

/** Format milliseconds as "Xm Ys" or "Zs". */
function fmtMs(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  return mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
}

/** Load a simnode config file and return the Simulation instance. */
async function loadSim(configPath: string): Promise<any> {
  const abs = path.resolve(configPath);
  let mod: any;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (err) {
    console.error(`Failed to load config: ${abs}`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const sim = mod.default ?? mod.simulation ?? mod.sim;
  if (!sim || typeof sim.run !== 'function') {
    console.error('Config must export a Simulation instance as default export');
    process.exit(1);
  }
  return sim;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const getArg = (name: string): string | undefined => {
    const found = args.find(a => a.startsWith(`--${name}=`));
    return found?.split('=').slice(1).join('=');
  };

  if (!command || command === '--help') {
    console.log([
      'Usage:',
      '  simnode run   [--config=<path>] [--seeds=<N>] [--stop-on-first-failure=<bool>]',
      '  simnode replay --seed=<N> --scenario="<name>" [--config=<path>]',
      '  simnode hunt  <scenario-path>  [--timeout=<duration>]',
      '',
      'Duration format: 30s | 5m | 1h',
    ].join('\n'));
    process.exit(0);
  }

  // ── run ──────────────────────────────────────────────────────────────────
  if (command === 'run') {
    const sim = await loadSim(getArg('config') ?? 'simnode.config.js');
    const seeds = parseInt(getArg('seeds') ?? '1');
    const stopRaw = getArg('stop-on-first-failure');
    const stopOnFirstFailure = stopRaw === undefined ? true : stopRaw !== 'false';

    const result = await sim.run({ seeds, stopOnFirstFailure });

    for (const f of result.failures) {
      console.log(`✗ [seed=${f.seed}] ${f.name}${f.error ? ': ' + f.error : ''}`);
      console.log('  Timeline:');
      console.log(f.timeline.split('\n').map((l: string) => '    ' + l).join('\n'));
    }
    const total = result.passes + result.failures.length;
    console.log(`\n${result.passes}/${total} passed${result.failures.length > 0 ? `, ${result.failures.length} failed` : ''}`);
    process.exit(result.passed ? 0 : 1);
  }

  // ── replay ───────────────────────────────────────────────────────────────
  if (command === 'replay') {
    const sim = await loadSim(getArg('config') ?? 'simnode.config.js');
    const seed = parseInt(getArg('seed') ?? '0');
    const scenario = getArg('scenario');
    if (!scenario) { console.error('--scenario required'); process.exit(1); }
    const result = await sim.replay({ seed, scenario });
    const s = result.result;
    console.log(`Replaying: ${s.name} (seed=${s.seed})`);
    console.log(s.timeline);
    if (!s.passed && s.error) console.error(`\nError: ${s.error}`);
    process.exit(s.passed ? 0 : 1);
  }

  // ── hunt ─────────────────────────────────────────────────────────────────
  if (command === 'hunt') {
    const scenarioArg = args[1];
    if (!scenarioArg || scenarioArg.startsWith('--')) {
      console.error('Usage: simnode hunt <scenario-path> [--timeout=<duration>]');
      process.exit(1);
    }

    const { Simulation } = await import('./index.js');
    const timeoutMs = parseDuration(getArg('timeout') ?? '5m');
    const scenarioPath = path.resolve(scenarioArg);

    // Build a fresh Simulation with a random base seed for broad coverage.
    const sim = new Simulation({ seed: Math.floor(Math.random() * 1_000_000_000) });
    sim.scenario(path.basename(scenarioArg, path.extname(scenarioArg)), scenarioPath);

    // Ctrl+C: set a flag so the hunt loop stops cleanly after the current seed.
    const abort = { aborted: false };
    process.once('SIGINT', () => {
      abort.aborted = true;
      process.stdout.write('\n[SIGINT] Stopping after current seed...\n');
    });

    console.log(`Hunting: ${path.basename(scenarioArg)}  (timeout: ${getArg('timeout') ?? '5m'})\n`);

    const huntResult = await sim.hunt({
      timeout: timeoutMs,
      signal: abort,
      onProgress: (seed: number, passed: boolean) => {
        process.stdout.write(`[${passed ? 'OK  ' : 'FAIL'}] Seed ${seed}\n`);
      },
    });

    if (huntResult.failure) {
      const f = huntResult.failure;
      console.log('\n' + '─'.repeat(60));
      console.log(`FAILURE FOUND after ${huntResult.seedsRun} seeds in ${fmtMs(huntResult.elapsedMs)}`);
      console.log(`  Scenario : ${f.name}`);
      console.log(`  Seed     : ${f.seed}`);
      console.log(`  Error    : ${f.error ?? '(no message)'}`);
      console.log('\nTimeline:');
      console.log(f.timeline.split('\n').map((l: string) => '  ' + l).join('\n'));
      console.log('\nReplay command:');
      console.log(`  simnode replay --seed=${f.seed} --scenario="${f.name}" --config=<your-config>`);
      process.exit(1);
    }

    const reason = abort.aborted ? 'interrupted by Ctrl+C' : `timeout after ${fmtMs(timeoutMs)}`;
    console.log(`\nNo failure found after ${huntResult.seedsRun} seeds in ${fmtMs(huntResult.elapsedMs)} (${reason}).`);
    console.log('Your scenario may be correct, or the bug requires a specific condition not yet explored.');
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
