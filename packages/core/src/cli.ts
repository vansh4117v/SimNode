#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help') {
    console.log('Usage:\n  simnode run [--config=<path>] [--seeds=<N>]\n  simnode replay --seed=<N> --scenario="<name>" [--config=<path>]');
    process.exit(0);
  }

  const getArg = (name: string): string | undefined => {
    const found = args.find(a => a.startsWith(`--${name}=`));
    return found?.split('=').slice(1).join('=');
  };

  const configPath = getArg('config') ?? 'simnode.config.js';
  const absConfig = path.resolve(configPath);

  let mod: any;
  try {
    mod = await import(pathToFileURL(absConfig).href);
  } catch (err) {
    console.error(`Failed to load config: ${absConfig}`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const sim = mod.default ?? mod.simulation ?? mod.sim;
  if (!sim || typeof sim.run !== 'function') {
    console.error('Config must export a Simulation instance as default export');
    process.exit(1);
  }

  if (command === 'run') {
    const seeds = parseInt(getArg('seeds') ?? '1');
    const result = await sim.run({ seeds });
    for (const s of result.scenarios) {
      const icon = s.passed ? '✓' : '✗';
      console.log(`${icon} [seed=${s.seed}] ${s.name}${s.error ? ': ' + s.error : ''}`);
      if (!s.passed) {
        console.log('  Timeline:');
        console.log(s.timeline.split('\n').map((l: string) => '    ' + l).join('\n'));
      }
    }
    process.exit(result.passed ? 0 : 1);
  }

  if (command === 'replay') {
    const seed = parseInt(getArg('seed') ?? '0');
    const scenario = getArg('scenario');
    if (!scenario) { console.error('--scenario required'); process.exit(1); }
    const result = await sim.replay({ seed, scenario });
    const s = result.scenarios[0];
    console.log(`Replaying: ${s.name} (seed=${s.seed})`);
    console.log(s.timeline);
    process.exit(s.passed ? 0 : 1);
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
