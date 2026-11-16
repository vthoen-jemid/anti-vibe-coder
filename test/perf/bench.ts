/**
 * Micro-benchmarks for the hot paths of the extension.
 *
 *   npm run bench            all benchmarks
 *   npm run bench -- --quick skip the slowest cases
 *
 * Pure logic (line keys, new-line detection) runs in-process. The git
 * benchmarks build a throw-away repository in the OS temp folder.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git } from '../../src/git/git';
import { Repo } from '../../src/git/repo';
import { computeLineKeys, splitLines } from '../../src/tracking/lineKeys';
import { computeNewLines } from '../../src/tracking/newLines';

const quick = process.argv.includes('--quick');

// ------------------------------------------------------------------ helpers

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['const', 'value', 'return', 'await', 'items', 'map', 'filter', 'repo', 'state', 'line', 'if', 'for', 'node', 'result'];

function codeLine(r: () => number): string {
  const indent = '  '.repeat(Math.floor(r() * 4));
  const n = 2 + Math.floor(r() * 6);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(WORDS[Math.floor(r() * WORDS.length)]);
  }
  return `${indent}${parts.join(' ')}(${Math.floor(r() * 1000)});`;
}

function makeFile(lines: number, seed: number): string[] {
  const r = rng(seed);
  return Array.from({ length: lines }, () => codeLine(r));
}

/** Rewrites `fraction` of the lines (random positions), keeping the line count. */
function rewrite(base: string[], fraction: number, seed: number): string[] {
  const r = rng(seed);
  return base.map((l) => (r() < fraction ? codeLine(r) + ' // changed' : l));
}

function time<T>(fn: () => T, minMs = 200, maxRuns = 1000): { ms: number; runs: number; result: T } {
  let result = fn(); // warm-up
  const start = performance.now();
  let runs = 0;
  do {
    result = fn();
    runs++;
  } while (performance.now() - start < minMs && runs < maxRuns);
  return { ms: (performance.now() - start) / runs, runs, result };
}

async function timeAsync<T>(fn: () => Promise<T>, runs = 3): Promise<{ ms: number; result: T }> {
  let result = await fn(); // warm-up
  const start = performance.now();
  for (let i = 0; i < runs; i++) {
    result = await fn();
  }
  return { ms: (performance.now() - start) / runs, result };
}

const rows: [string, string][] = [];
function report(name: string, ms: number, extra = ''): void {
  const s = ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
  rows.push([name, s + (extra ? `  (${extra})` : '')]);
  console.log(`${name.padEnd(48)} ${s}${extra ? `  (${extra})` : ''}`);
}

// ------------------------------------------------------------------ pure logic

function benchPure(): void {
  console.log('\n# Pure logic\n');
  const sizes = quick ? [1_000, 10_000] : [1_000, 10_000, 50_000];
  for (const n of sizes) {
    const base = makeFile(n, n);
    const text = base.join('\n');
    report(`split + line keys, ${n} lines`, time(() => computeLineKeys(splitLines(text))).ms);
  }
  for (const n of sizes) {
    const base = makeFile(n, n);
    const baseText = base.join('\n');
    const cases: [string, string[]][] = [
      ['small edit', (() => { const c = [...base]; c.splice(Math.floor(n / 2), 3, 'a()', 'b()', 'c()', 'd()'); return c; })()],
      ['30% rewritten', rewrite(base, 0.3, 7)],
      ['fully rewritten', rewrite(base, 1, 9)],
    ];
    for (const [label, cur] of cases) {
      if (label === 'fully rewritten' && n > 10_000) {
        continue; // quadratic before the timeout fallback; would take minutes
      }
      const t = time(() => computeNewLines(baseText, cur, true), 200, label === 'small edit' ? 1000 : 5);
      const marked = t.result.reduce((a, b) => a + b, 0);
      report(`new lines, ${n} lines, ${label}`, t.ms, `${marked} marked new`);
    }
  }
}

// ------------------------------------------------------------------ git

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function buildRepo(files: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antivibe-bench-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'bench@example.invalid');
  sh(dir, 'config', 'user.name', 'bench');
  sh(dir, 'config', 'core.autocrlf', 'false');
  for (let i = 0; i < files; i++) {
    const p = path.join(dir, 'src', `dir${i % 10}`, `file${i}.ts`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, makeFile(200, i).join('\n') + '\n');
  }
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'feature');
  for (let i = 0; i < files; i++) {
    const p = path.join(dir, 'src', `dir${i % 10}`, `file${i}.ts`);
    fs.writeFileSync(p, rewrite(makeFile(200, i), 0.2, i + 1).join('\n') + '\n');
  }
  sh(dir, 'commit', '-q', '-am', 'feature');
  return dir;
}

async function benchGit(): Promise<void> {
  console.log('\n# Git\n');
  for (const n of quick ? [50] : [50, 300]) {
    const dir = buildRepo(n);
    try {
      const repo = new Repo(dir);
      const refresh = await timeAsync(() => repo.refresh(() => ''));
      report(`Repo.refresh (auto-detect base), ${n} changed files`, refresh.ms);
      const rels = [...repo.changed];
      const mb = repo.mergeBase;

      const show = await timeAsync(() => Promise.all(rels.map((rel) => git(dir, ['show', `${mb}:${rel}`]))), 2);
      report(`load ${n} base versions: git show per file`, show.ms);

      const viaRepo = await timeAsync(async () => {
        const fresh = new Repo(dir);
        await fresh.refresh(() => '');
        const t0 = performance.now();
        await Promise.all(rels.map((rel) => fresh.loadBase(rel)));
        const ms = performance.now() - t0;
        fresh.dispose();
        return ms;
      }, 2);
      report(`load ${n} base versions: Repo.loadBase`, viaRepo.result);
      repo.dispose();
    } finally {
      // Async: disposed cat-file processes exit once the event loop has closed their stdin.
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
}

async function main(): Promise<void> {
  console.log(`node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus()[0]?.model ?? ''}`);
  benchPure();
  await benchGit();
  console.log('\n| Benchmark | Time |\n| --- | --- |');
  for (const [k, v] of rows) {
    console.log(`| ${k} | ${v} |`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
