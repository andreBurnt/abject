/**
 * Which backend an installed `abject` runs: the headless archive carries the
 * headless edition, the server archive the desktop edition (a desktop with no
 * window of its own, opened from browsers by pairing). `abject serve` runs
 * whichever the install has, and only the server archive counts as serving
 * the desktop, so the command may stop and update it as its own.
 *
 * Run: npx tsx --test cli/backend.install.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installEntry, installHome, servesDesktop } from './backend.js';

function fakeInstall(serverFile: string | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abject-install-'));
  const dir = path.join(home, 'lib', 'dist-server', 'server');
  fs.mkdirSync(dir, { recursive: true });
  if (serverFile) fs.writeFileSync(path.join(dir, serverFile), '');
  return home;
}

function withHome<T>(home: string, fn: () => T): T {
  const before = process.env.ABJECT_HOME;
  process.env.ABJECT_HOME = home;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.ABJECT_HOME; else process.env.ABJECT_HOME = before;
  }
}

test('the headless archive runs the headless edition and does not serve the desktop', () => {
  const home = fakeInstall('headless.js');
  assert.equal(installEntry(home), path.join(home, 'lib', 'dist-server', 'server', 'headless.js'));
  withHome(home, () => {
    assert.equal(installHome(), home);
    assert.equal(servesDesktop(), false);
  });
});

test('the server archive runs the desktop edition and serves the desktop', () => {
  const home = fakeInstall('index.js');
  assert.equal(installEntry(home), path.join(home, 'lib', 'dist-server', 'server', 'index.js'));
  withHome(home, () => assert.equal(servesDesktop(), true));
});

test('a directory with neither backend is not an install', () => {
  assert.equal(installEntry(fakeInstall(null)), undefined);
});
