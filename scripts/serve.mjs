#!/usr/bin/env node
// Local "one command" orchestrator: start the API (infra), wait for it to be
// healthy, then start the web console (app) — the same infra-before-app
// ordering docker-compose expresses with `depends_on: service_healthy`.
//
// Zero dependencies: Node 22's built-in fetch + child_process. Invoked by the
// Nx `@kdo/web:serve` target, which builds both projects first (dependsOn).
import { spawn } from 'node:child_process';
import process from 'node:process';

const API_PORT = process.env.PORT ?? '3001';
const HEALTH_URL = `http://localhost:${API_PORT}/api/health`;
const HEALTH_TIMEOUT_MS = 60_000;

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function start(name, args) {
  const child = spawn('pnpm', args, { env: process.env });
  const tag = `[${name}] `;
  const pipe = (src, dst) => {
    let buffer = '';
    src.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) dst.write(`${tag}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`${tag}exited with code ${code} — stopping all\n`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stderr.write(`api did not become healthy at ${HEALTH_URL} within ${HEALTH_TIMEOUT_MS}ms\n`);
  shutdown(1);
}

console.log('▶ starting api (infra) …');
start('api', ['--filter', '@kdo/api', 'start']);

await waitForHealth();

console.log(`✓ api healthy at ${HEALTH_URL} — starting web (app) …`);
start('web', ['--filter', '@kdo/web', 'start']);

console.log('\n  kdo is up →  web http://localhost:3000   api http://localhost:3001');
console.log('  (Ctrl+C stops both)\n');
