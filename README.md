# gha

Shared GitHub Actions for repos under `juanlentino`.

Public on purpose: these contain no secrets, public repos need no
`Actions → General → Access` setting to be consumable from elsewhere, and the
repo's own CI is free.

## Why composite actions, not reusable workflows

**GitHub bills per _job_, rounded up to the whole minute.** Four parallel jobs
of 40 seconds bill 4 minutes, not 1.

Composite action steps execute **inside the calling job**, so everything rounds
once. A reusable workflow (`jobs.<id>.uses`) creates a **separate job** that
rounds separately — using one to share CI would defeat the entire purpose.

Measured on a real repo before consolidating: three jobs each paying their own
checkout + `setup-node` + `npm ci`. Install was 40–61s of every 60–87s job, run
three times, for **32s** of combined actual work — about **5–6 billed minutes
per push**. One job doing all three is ~102s → **2 billed minutes**.

## `node-ci`

Install once, then typecheck + lint + test in a single billed job.

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    # Without this the job inherits GitHub's 6-HOUR default, so one hung run
    # bills 360 minutes — 12% of a Pro monthly allowance from one incident.
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v5
      - uses: juanlentino/gha/node-ci@v1
```

### Inputs

| input | default | notes |
|---|---|---|
| `node-version-file` | `.nvmrc` | Ignored if the file is absent, so repos without one still work |
| `node-version` | — | Used only when `node-version-file` is absent |
| `install` | `npm ci` | Override for repos with no lockfile |
| `typecheck` / `lint` / `test` | `true` | Each is skipped anyway if the npm script doesn't exist |
| `cache-node-modules` | `false` | See the warning below |

### Behaviour worth knowing

- **All three checks run even if an earlier one fails**, so one run tells you
  everything that's broken. A final gate step fails the job — without it,
  `continue-on-error` would make a broken build green.
- **Missing scripts are skipped, not failed**, so the same action works across
  repos with different tooling.
- **`cache-node-modules` is off by default.** It turns a ~60s install into a ~5s
  restore, but skips npm's install lifecycle — any dependency with a
  `postinstall` (native builds, playwright, prisma generate) is silently missing
  on a cache hit. Audit before enabling. `setup-node`'s own `cache: npm` is
  always on and caches `~/.npm` tarballs, **not** `node_modules`, which is why
  it doesn't make `npm ci` fast.

## Pinning

`@v1` is a moving major tag. Pin a commit SHA if you want immutability.
