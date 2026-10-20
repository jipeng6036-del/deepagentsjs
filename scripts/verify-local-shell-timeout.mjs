import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const sourceRoot = path.resolve(process.argv[2]);
const mode = process.argv[3];
assert.ok(mode === 'baseline' || mode === 'candidate');
// This is the built entry exported as deepagents/node, not an extracted helper.
const { LocalShellBackend } = await import(
  pathToFileURL(path.join(sourceRoot, 'libs/deepagents/dist/node.js')).href
);
const sourceCommit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const results = [];
const workerDelayMs = process.platform === 'win32' ? 8000 : 3000;
const cleanupBoundMs = process.platform === 'win32' ? 7000 : 2700;
const cases = [
  { redirect: false, ignoreTerm: false },
  { redirect: true, ignoreTerm: false },
  ...(process.platform === 'win32' ? [] : [
    { redirect: false, ignoreTerm: true },
    { redirect: true, ignoreTerm: true },
  ]),
];

for (const scenario of cases) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'deepagents-timeout-proof-'));
  const backend = await LocalShellBackend.create({
    rootDir,
    timeout: 1.5,
    inheritEnv: true,
  });
  try {
    const control = await backend.execute('echo timeout-proof-control');
    assert.equal(control.exitCode, 0);
    assert.match(control.output, /timeout-proof-control/);
    await writeFile(path.join(rootDir, 'worker.cjs'), [
      "const fs = require('node:fs');",
      scenario.ignoreTerm ? "process.on('SIGTERM', () => {});" : '',
      "fs.writeFileSync('ready.txt', String(process.pid));",
      `setTimeout(() => fs.writeFileSync('late.txt', 'late write'), ${workerDelayMs});`,
    ].join('\n'));
    const redirect = scenario.redirect
      ? (process.platform === 'win32' ? ' > NUL 2>&1' : ' > /dev/null 2>&1')
      : '';
    const tail = process.platform === 'win32' ? ' & rem keep the shell as parent' : '; :';
    const command = `"${process.execPath}" worker.cjs${redirect}${tail}`;
    const started = performance.now();
    const response = await backend.execute(command);
    const elapsedMs = Math.round(performance.now() - started);
    const readyAtReturn = existsSync(path.join(rootDir, 'ready.txt'));
    const markerAtReturn = existsSync(path.join(rootDir, 'late.txt'));
    await delay(Math.max(0, workerDelayMs + 1000 - elapsedMs));
    const markerAfterWait = existsSync(path.join(rootDir, 'late.txt'));
    const fixed = response.exitCode === 124 && readyAtReturn && elapsedMs < cleanupBoundMs && !markerAfterWait;
    const row = { ...scenario, elapsedMs, readyAtReturn, markerAtReturn, markerAfterWait,
      exitCode: response.exitCode, output: response.output, fixed };
    results.push(row);
    console.log(JSON.stringify(row));
    assert.equal(response.exitCode, 124);
    assert.ok(readyAtReturn, 'The worker must actually have started before timing out');
    if (mode === 'baseline') {
      assert.equal(markerAfterWait, true, 'The unchanged baseline must reproduce the late write');
      assert.equal(fixed, false);
    } else {
      assert.equal(fixed, true, 'Timeout must stop the real worker within a bounded cleanup allowance');
    }
  } finally {
    await backend.close();
    // Workers are finite; every case waits past their natural write/exit deadline.
    // Cleanup touches only the directory returned by mkdtemp for this case.
    await rm(rootDir, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ mode, sourceCommit, node: process.version,
  platform: process.platform, arch: process.arch, workerDelayMs, cleanupBoundMs, cases: results.length,
  expectedBehaviorVerified: true, results }));
