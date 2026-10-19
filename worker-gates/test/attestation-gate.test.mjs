// #31: the gate once judged drift per package NAME, not name@version. With two
// locked versions of one package where only the newer attests, the unattested
// older copy was invisible. Ported from signal-and-noise-analytics-worker's
// vitest spec when the gate moved here; node:test so this repo needs no install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDrift } from '../attestation-gate.mjs';

test('surfaces an unattested OLDER copy even when a newer copy of the same name attests', () => {
  const installed = [{ name: 'left-pad', version: '1.0.0' }, { name: 'left-pad', version: '2.0.0' }];
  const attested = [{ name: 'left-pad', version: '2.0.0' }];
  const { unattested, unreviewed } = computeDrift({ installed, attested, allowed: new Set() });
  assert.deepEqual(unattested, ['left-pad@1.0.0']);
  assert.deepEqual(unreviewed, ['left-pad@1.0.0']);
});

test('the allowlist still matches by bare NAME, covering every version of that name', () => {
  const installed = [{ name: 'never-attests', version: '1.0.0' }, { name: 'never-attests', version: '2.0.0' }];
  const { unreviewed } = computeDrift({ installed, attested: [], allowed: new Set(['never-attests']) });
  assert.deepEqual(unreviewed, []);
});

test('reports a NAME as stale only once every installed version of it attests', () => {
  const installed = [{ name: 'p', version: '1.0.0' }, { name: 'p', version: '2.0.0' }];
  const both = [{ name: 'p', version: '1.0.0' }, { name: 'p', version: '2.0.0' }];
  assert.deepEqual(computeDrift({ installed, attested: both, allowed: new Set(['p']) }).stale, ['p']);
  const one = [{ name: 'p', version: '2.0.0' }];
  assert.deepEqual(computeDrift({ installed, attested: one, allowed: new Set(['p']) }).stale, []);
});

test('a scoped name keeps its scope when the version is split off', () => {
  const installed = [{ name: '@scope/pkg', version: '1.0.0' }];
  const { unreviewed } = computeDrift({ installed, attested: [], allowed: new Set(['@scope/pkg']) });
  assert.deepEqual(unreviewed, []);
});

test('a normal fully-attested tree reports zero unattested', () => {
  const installed = [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.0' }];
  const r = computeDrift({ installed, attested: installed, allowed: new Set() });
  assert.deepEqual(r.unattested, []);
  assert.deepEqual(r.unreviewed, []);
  assert.equal(r.installedCount, 2);
  assert.equal(r.attestedCount, 2);
});
