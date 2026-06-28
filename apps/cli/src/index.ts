#!/usr/bin/env -S npx tsx
import { z } from 'zod';
import type { Run, Step } from '@kdo/core';
import { loadConfig } from './config';
import { ApiError, checkHealth, getRun, submitDeployment } from './client';

const DEFAULT_API = process.env.KDO_API ?? 'http://localhost:3001';
const TERMINAL = new Set<Run['status']>(['succeeded', 'failed', 'rolled_back']);

// -- tiny ANSI helper (respects NO_COLOR / non-TTY) -------------------------
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  green: (s: string) => paint(32, s),
  red: (s: string) => paint(31, s),
  yellow: (s: string) => paint(33, s),
  dim: (s: string) => paint(2, s),
  bold: (s: string) => paint(1, s),
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Args {
  command?: string;
  file?: string;
  api?: string;
  json: boolean;
  follow: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, follow: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--no-follow') args.follow = false;
    else if (a === '-f' || a === '--file') args.file = argv[++i];
    else if (a === '--api') args.api = argv[++i];
    else if (a !== undefined && !a.startsWith('-') && !args.command) args.command = a;
  }
  return args;
}

const USAGE = `kdo — Kubernetes Deploy Orchestrator CLI

Usage:
  kdo apply -f <config.yaml> [--api <url>] [--no-follow] [--json]

Options:
  -f, --file <path>   YAML config declaring one or more deployments (required)
  --api <url>         API base URL (default: $KDO_API or http://localhost:3001)
  --no-follow         submit and exit without waiting for terminal state
  --json              print the final run objects as JSON
  -h, --help          show this help

Exit codes: 0 all succeeded · 1 a rollout failed/rolled back · 2 usage/connection error
`;

function duration(step: Step): string {
  if (!step.startedAt || !step.finishedAt) return '';
  const ms = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function printStep(step: Step): void {
  if (step.status === 'succeeded') {
    console.log(`  ${c.green('✓')} ${step.name} ${c.dim(duration(step))}`);
  } else if (step.status === 'failed') {
    console.log(`  ${c.red('✗')} ${step.name} ${c.red(`— ${step.error ?? 'failed'}`)}`);
  } else if (step.status === 'skipped') {
    console.log(`  ${c.dim(`· ${step.name} (skipped)`)}`);
  }
}

/** Poll a run to completion, printing steps as they settle. */
async function follow(apiBase: string, initial: Run): Promise<Run> {
  const printed = new Set<string>();
  let run = initial;
  let transientErrors = 0;
  for (;;) {
    try {
      run = await getRun(apiBase, run.id);
      transientErrors = 0;
    } catch (err) {
      // Tolerate the occasional transient network blip while polling.
      if (++transientErrors > 5) throw err;
      await sleep(300);
      continue;
    }
    for (const step of run.steps) {
      const settled =
        step.status === 'succeeded' || step.status === 'failed' || step.status === 'skipped';
      if (settled && !printed.has(step.id)) {
        printed.add(step.id);
        printStep(step);
      }
    }
    if (TERMINAL.has(run.status)) return run;
    await sleep(300);
  }
}

function statusLabel(status: Run['status']): string {
  if (status === 'succeeded') return c.green(status);
  if (status === 'rolled_back') return c.yellow(status);
  if (status === 'failed') return c.red(status);
  return status;
}

async function apply(args: Args): Promise<number> {
  if (!args.file) {
    console.error(c.red('error: --file <config.yaml> is required\n'));
    console.error(USAGE);
    return 2;
  }

  let config;
  try {
    config = loadConfig(args.file);
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error(c.red('invalid config:'));
      for (const issue of err.issues) {
        console.error(`  ${c.red('✗')} ${issue.path.join('.') || 'config'}: ${issue.message}`);
      }
    } else {
      console.error(c.red(`could not read config: ${(err as Error).message}`));
    }
    return 2;
  }

  const apiBase = args.api ?? config.apiBaseUrl ?? DEFAULT_API;
  try {
    await checkHealth(apiBase);
  } catch (err) {
    console.error(c.red(err instanceof ApiError ? err.message : String(err)));
    return 2;
  }

  console.log(c.dim(`api: ${apiBase} · ${config.deployments.length} deployment(s)\n`));

  const results: Run[] = [];
  for (const spec of config.deployments) {
    console.log(
      c.bold(`▶ ${spec.namespace}/${spec.name}`) + c.dim(` (${spec.image}, ${spec.strategy.kind})`),
    );
    try {
      const submitted = await submitDeployment(apiBase, spec);
      if (!args.follow) {
        console.log(c.dim(`  submitted: ${submitted.id}`));
        results.push(submitted);
        continue;
      }
      const final = await follow(apiBase, submitted);
      console.log(`  ${statusLabel(final.status)} — ${final.message ?? ''}\n`);
      results.push(final);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      console.error(`  ${c.red('✗')} ${message}`);
      if (err instanceof ApiError && err.issues) console.error(`    ${JSON.stringify(err.issues)}`);
      return 2;
    }
  }

  if (args.json) console.log(JSON.stringify(results, null, 2));

  const failed = results.filter((r) => r.status === 'failed' || r.status === 'rolled_back');
  if (failed.length > 0) {
    console.error(c.red(`\n${failed.length}/${results.length} deployment(s) did not succeed`));
    return 1;
  }
  console.log(c.green(`\n✓ all ${results.length} deployment(s) succeeded`));
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  if (args.command !== 'apply') {
    console.error(c.red(`unknown command: ${args.command}\n`));
    console.log(USAGE);
    process.exit(2);
  }
  process.exit(await apply(args));
}

void main();
