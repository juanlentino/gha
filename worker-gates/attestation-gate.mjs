#!/usr/bin/env node
/**
 * Dependency-provenance gate (R6c).
 *
 * WHAT THIS GATES, precisely:
 *   1. Registry signatures — every installed package must carry a valid npm
 *      registry signature. `npm audit signatures` reports `invalid` / `missing`;
 *      either being non-empty is a hard fail. This leg is currently 100% clean.
 *   2. Attestation drift — the set of installed packages WITHOUT a provenance
 *      attestation must not grow beyond the reviewed allowlist. A new name means
 *      either a new never-attests dependency entered the tree, or a package that
 *      used to attest stopped. Both are reviewed events, per the conditions in
 *      docs/ops/attestation-coverage-audit-2026-08-14.md (plugin repo).
 *
 *      #31: drift is judged per `name@version`, not per bare name. Two locked
 *      versions of one package can exist (a transitive + a direct pin); if only
 *      the newer attests, keying on name alone let the newer copy's attestation
 *      hide the older, unattested copy entirely. The allowlist itself stays
 *      keyed BY NAME (a reviewed decision covers a package, not one version of
 *      it) — computeDrift() below keeps that split explicit.
 *
 * WHAT THIS DOES NOT GATE: a coverage PERCENTAGE. Coverage is reported, never
 * enforced — the tree is pure toolchain (all five workers declare zero runtime
 * dependencies), so the meaningful question is "did the set change?", not "is
 * the ratio high?". Chasing a ratio would push names onto the allowlist to make
 * a number move, which is the inversion this gate exists to avoid.
 *
 * PLATFORM-BOUND. Optional platform packages differ per OS (`fsevents` and
 * `lightningcss-darwin-arm64` install on macOS and never on Linux). The
 * allowlist is derived for ONE platform, recorded in its `platform` field. On a
 * mismatch this reports and declines to judge locally, but FAILS in CI — an
 * allowlist judged against the wrong population is not a gate.
 *
 * Requires npm >= 11: npm 10 accepts `--include-attestations` but silently omits
 * the `verified` array, which would make every package read as unattested.
 * The instrument is asserted below rather than trusted.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ALLOWLIST = '.attestation-allowlist.json';

function npm(args) {
  return execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// ── pure drift computation (#31), exported for unit tests ───────────────────
// installed/attested: arrays of {name, version} — one entry per locked
// package@version. allowed: a Set of bare NAMES (the reviewed allowlist).
export function computeDrift({ installed, attested, allowed }) {
  const key = (p) => `${p.name}@${p.version}`;
  const nameOf = (k) => k.slice(0, k.lastIndexOf('@'));
  const installedKeys = new Set(installed.map(key));
  const attestedKeys = new Set(attested.map(key));

  const unattested = [...installedKeys].filter((k) => !attestedKeys.has(k)).sort();
  const unreviewed = unattested.filter((k) => !allowed.has(nameOf(k)));
  // A NAME is stale only once every installed version of it now attests —
  // one unattested version anywhere still needs that allowlist entry.
  const unattestedNames = new Set(unattested.map(nameOf));
  const stale = [...allowed].filter((n) => !unattestedNames.has(n)).sort();

  return {
    installedCount: installedKeys.size,
    attestedCount: attestedKeys.size,
    unattested,
    unreviewed,
    stale,
  };
}

function main() {
  const inCI = Boolean(process.env.CI);
  const fail = [];
  const notice = [];

  const policy = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  const allowed = new Set(policy.never_attests);
  const wantPlatform = policy.platform;
  const havePlatform = `${process.platform}/${process.arch}`;

  // ── the instrument, asserted before it is believed ─────────────────────────
  let audit;
  try {
    audit = JSON.parse(npm(['audit', 'signatures', '--json', '--include-attestations']));
  } catch (e) {
    // npm exits non-zero when signatures are invalid/missing; the JSON is still on stdout.
    if (!e.stdout) { console.error('FATAL: `npm audit signatures` produced no output.'); process.exit(2); }
    audit = JSON.parse(e.stdout);
  }
  if (!Array.isArray(audit.verified)) {
    console.error('FATAL: npm did not return a `verified` array. This npm is too old for');
    console.error('       --include-attestations (npm 10 omits it silently). Need npm >= 11.');
    console.error(`       npm reports: ${npm(['--version']).trim()}`);
    process.exit(2);
  }

  const query = JSON.parse(npm(['query', '*', '--json']));
  const rootName = JSON.parse(readFileSync('package.json', 'utf8')).name;
  const installed = query.filter((p) => p.name && p.name !== rootName).map((p) => ({ name: p.name, version: p.version }));
  const attested = audit.verified.map((p) => ({ name: p.name, version: p.version }));

  const { installedCount, attestedCount, unattested, unreviewed, stale } = computeDrift({ installed, attested, allowed });

  // ── vacuous-pass guards: an empty measurement must never read as "clean" ──
  if (installedCount === 0) fail.push('measured ZERO installed packages — run `npm ci` first');
  if (attestedCount === 0) fail.push('measured ZERO attestations — the attestation lookup is broken, not the tree');

  const coverage = installedCount ? (100 * attestedCount / installedCount) : 0;

  // ── platform gate ─────────────────────────────────────────────────────────
  const platformOK = havePlatform === wantPlatform;
  if (!platformOK) {
    const msg = `allowlist was derived for ${wantPlatform}, this host is ${havePlatform}`;
    if (inCI) fail.push(`${msg} — refusing to judge in CI against the wrong population`);
    else notice.push(`${msg} — reporting only, no verdict (optional platform deps differ)`);
  }

  // ── leg 1: registry signatures ────────────────────────────────────────────
  for (const p of audit.invalid) fail.push(`INVALID registry signature: ${p.name}@${p.version}`);
  for (const p of audit.missing) fail.push(`MISSING registry signature: ${p.name}@${p.version}`);

  // ── leg 2: attestation drift ──────────────────────────────────────────────
  if (platformOK && unreviewed.length) {
    fail.push(`${unreviewed.length} package(s) lack an attestation and are NOT on the reviewed allowlist:`);
    for (const k of unreviewed) fail.push(`    + ${k}`);
    fail.push('  Either the package should attest (investigate the upstream release),');
    fail.push(`  or add it to ${ALLOWLIST} as a reviewed decision — never silently.`);
  }
  if (platformOK && stale.length) {
    notice.push(`${stale.length} allowlist entr${stale.length === 1 ? 'y' : 'ies'} no longer needed (now attesting or gone) — prune: ${stale.join(', ')}`);
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log(`platform            ${havePlatform}${platformOK ? '' : `  (allowlist: ${wantPlatform})`}`);
  console.log(`installed           ${installedCount}`);
  console.log(`registry signatures ${installedCount - audit.invalid.length - audit.missing.length}/${installedCount} valid`);
  console.log(`attested            ${attestedCount}  (${coverage.toFixed(1)}% — reported, not enforced)`);
  console.log(`unattested          ${unattested.length}  (allowlist pins ${allowed.size})`);
  for (const n of notice) console.log(`NOTICE: ${n}`);
  if (fail.length) {
    console.error('\nFAIL');
    for (const f of fail) console.error(`  ${f}`);
    process.exit(1);
  }
  // A verdict names what it actually checked. When the platform check declines
  // leg 2, printing "PASS — no unreviewed unattested packages" would claim a check
  // that never ran — the success-only readout this gate exists to prevent.
  if (platformOK) {
    console.log('\nPASS — signatures all valid, no unreviewed unattested packages.');
  } else {
    console.log(`\nNOT JUDGED — signatures all valid (leg 1 is platform-independent),`);
    console.log(`but the attestation allowlist was NOT evaluated here. The verdict that`);
    console.log(`counts is the one CI produces on ${wantPlatform}.`);
  }
}

// Run only when executed directly, not when imported by tests for computeDrift.
// Compared as real file URLs: a raw `file://${argv[1]}` misses on a symlinked
// or percent-encoded path, and a missed comparison skips main() and exits 0 --
// a green gate that checked nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
