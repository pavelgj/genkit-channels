# TODO: path to a polished release

Working checklist compiled from a sweep of the current prototype. Delete before
launch. Organized into three buckets: missing features, rough
implementation/APIs that need a redesign, and leftover experimental cruft that
needs cleanup. Blockers (things that break a published package) are called out
inline.

## Blockers (fix before any publish)

- [ ] **`bin` points at a file that does not exist.** `package.json` maps both
  `genkit-channel` and `genkit-channels` to `dist/bin/genkit-channels.js`, but
  the built file is `dist/bin/genkit-channel.js` (source is
  `src/bin/genkit-channel.ts`). A published package's CLI fails to launch.
  Either rename the source or fix the bin paths.
- [ ] **No LICENSE file.** `package.json` declares `Apache-2.0` and every source
  file has the header, but there is no `LICENSE` at the repo root. Needed for a
  compliant npm/OSS release.
- [ ] **Pin the CLI name and use it everywhere.** The package is
  `genkit-channels`, the CLI `.name()` is `genkit-channels`, the README uses
  `genkit-channels ...`, but every sample README/`channels.yaml` uses
  `genkit-channel deploy` (singular). Pick one, alias the other, and make docs
  consistent.
- [ ] **README references docs and a bench harness that are not in the repo.**
  `docs/DESIGN.md`, `docs/BENCHMARKS.md`, and `bench/` are all linked
  (README lines ~14, 190, 223, 238, 240) but do not exist. Either add them or
  strip the references. The entire "Overhead" table quotes hard numbers with no
  reproducible harness backing them.

## Missing features

- [ ] **Only one deploy target (`cloud-run`).** The target registry
  (`src/core/targets/index.ts`) is built to be pluggable but only registers
  Cloud Run. No other targets, no docs on how to add one.
- [ ] **`--local` only runs Node channels.** `src/commands/deploy.ts` throws for
  Go channels; Go/Python user apps only work via the container path. Local
  iteration is Node-only today.
- [ ] **Channel `image` field is parsed but never used.** `channel.yaml`'s
  prebuilt-image field is validated/stored (`core/channels/loader.ts`) and
  documented in `types.ts`, but `deploySidecar` always rebuilds the channel
  image and never reads `definition.image`. Either wire it up or drop it.
- [ ] **No auth on the transport or the reflection v2 hop.** Reflection v2 is
  unauthenticated and dev-oriented (child must run with `GENKIT_ENV=dev`). The
  HTTP channels expose actions with no authn/authz. This is the real
  production-readiness gap, not performance. Decide the story: a hardened,
  `GENKIT_ENV`-independent serve mode plus at least optional channel auth.
- [ ] **Channel runtime robustness.** No child-process crash recovery / restart,
  no reconnection/backoff on the WebSocket, no health/readiness endpoint, no
  graceful shutdown/drain. Confirm behavior when the child dies mid-request.
- [ ] **Python runtime is listed but unproven.** `core/runtimes/python.ts`
  exists; confirm it actually round-trips end to end (or mark experimental).
- [ ] **No CI.** No `.github/` workflow runs the existing test script on PRs.

## Rough implementation / APIs to refactor or redesign

- [ ] **Three parallel HTTP channels (`http`, `http-ts`, `http-go`).** `http`
  (plain JS) and `http-ts` (TS) are near line-for-line identical; `http-go` is a
  third port with the same wire behavior. Any bug fix must land in three places.
  Decide which ship as products vs. which are examples, and document the split.
- [ ] **`GENKIT_ENV=dev` requirement is a design smell.** The channel only works
  because it forces the child into dev mode so the reflection v2 client
  activates. This carries a perf/behavior tax and is not something to ship as
  the permanent mechanism. Needs a proper serve mode in Genkit core.
- [ ] **Review the `startAppProcess` / `AppProcess` public surface.**
  (`src/lib/app-process.ts`, ~550 lines.) It is the main thing channel authors
  build on, so lock it down before release: naming, what is public vs. internal,
  error types, streaming/`onChunk` contract, and lifecycle (`start`/`ready`).
- [ ] **Review the agent client surface** (`src/lib/agent-client.ts`):
  `createAgentApi`, `discoverAgents`, `getAgent`, chat/turn/session shapes.
  Same concern: this is public API and should be stable.
- [ ] **Manifest schema (`channels.yaml`) needs a spec + validation pass.**
  Nail down required vs. optional fields, error messages, and versioning of the
  format before users depend on it.
- [ ] **Error handling / surfacing.** Audit how child errors, action failures,
  and streaming errors propagate back through the channel to the transport.

## Cleanup (throwaway experiments and leftovers)

- [ ] **Machine-specific `.gitignore` entry.** `scratch/` is a
  "symlink to the linked genkit source (machine-specific)" - remove before
  release.
- [ ] **Add package metadata.** No `repository`, `homepage`, or `bugs` fields in
  `package.json`.
- [ ] **No linter/formatter.** No eslint/prettier/editorconfig config and no
  `lint`/`format` scripts. Only `tsc --strict` gates quality today.
- [ ] **`test:agent-dir` is excluded from `pnpm test`.** `test/agent-dir.mjs`
  runs only via a separate script. Either fold it into the main suite or
  document why it is separate.
- [ ] **Drop the "experimental" framing once stabilized.** README title,
  `package.json` description, and the CLI description all say "experimental".
  Sweep these when the API is locked.
- [ ] **Confirm no deprecated model strings ship.** Project source/samples use
  `googleai/gemini-flash-latest` (good). Just re-verify before launch that no
  `gemini-1.5` / `gemini-2.5` / `gemini-2.0` / `gemini-pro` sneak into any new
  sample, prompt, or doc.
- [ ] **Benchmark numbers in README.** Either land the `bench/` harness and
  `BENCHMARKS.md` so they are reproducible, or move the table behind a clearly
  labeled "informal, not reproducible" note.

## Open questions to resolve as a team

- [ ] What is the supported matrix at launch: which channels (http only? +
  discord?), which runtimes (js only? + go/python?), which targets (cloud-run
  only?).
- [ ] Is the reflection-v2-over-loopback model the shipping architecture, or an
  interim step until Genkit core grows a first-class serve mode?
- [ ] Semver commitment: is `startAppProcess` / agent-client considered stable
  API at 1.0, and what is the deprecation policy for `channels.yaml`?
