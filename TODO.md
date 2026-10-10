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
- [ ] **Channel `image` field is parsed but never used.** `channel.yaml`'s
  prebuilt-image field is validated/stored (`core/channels/loader.ts`) and
  documented in `types.ts`, but `deploySidecar` always rebuilds the channel
  image and never reads `definition.image`. Either wire it up or drop it.
- [x] ~~Reflection hop is unauthenticated / needs GENKIT_ENV=dev.~~ Fixed by
  moving to `@genkit-ai/box`: per-box secret, `GENKIT_REFLECTION_ENABLED`.
- [ ] **No auth on the transport.** The HTTP channels expose actions with no
  authn/authz. Decide on at least optional channel auth.
- [x] ~~Sidecar reflection secret is a plain env value in service.yaml.~~
  Won't fix, on purpose: it guards a loopback port inside one instance and is
  regenerated per deploy; Secret Manager would only add a setup step. (User
  secrets do go through Secret Manager; see README "Secrets".)
- [ ] **Secrets on more targets.** Secret references are platform-neutral
  strings; only Cloud Run (Secret Manager) interprets them today. Also
  consider a custom runtime service account (the printed IAM grant assumes the
  default compute account).
- [ ] **slack-webhook channel** (Events API over HTTP, signing secret,
  `access: public`). Share `bridge.ts` / `turn.ts` / `slack-reply.ts` with
  `slack-socket` once it exists. Also consider Slack's agent side panel
  (Assistant class: suggested prompts, thread titles).
- [ ] **slack-socket: followed threads are in memory** (lost on restart; not
  shared across instances). Could be derived from `conversations.replies`
  on demand instead.
- [ ] **Go channels.** Removed `http-go`; bring Go channels back as a clean
  port once there is a Go genkit-in-a-box. (Go *apps* still work: they only
  need to honor the reflection env vars.)
- [ ] **Channel runtime robustness.** Box now restarts a dead app on the next
  call (the in-flight call fails). Still missing: box lifecycle hooks for
  health/logs (box FR-7), graceful drain.
- [ ] **Remaining box asks** (lifecycle hooks, host-side store, output
  capture, Dev UI): see `scratch/box-frs.md`.
- [ ] **`genkit-channel check <deployment>`**: boot the app once and verify
  `expose` names (and `agentState`) against `listActions`. Typos currently
  surface on the first call.
- [ ] **Python runtime is listed but unproven.** `core/runtimes/python.ts`
  exists; confirm it actually round-trips end to end (or mark experimental).
- [ ] **No CI.** No `.github/` workflow runs the existing test script on PRs.

## Rough implementation / APIs to refactor or redesign

- [ ] **Two parallel HTTP channels (`http`, `http-ts`).** Plain JS and TS are
  near line-for-line identical, so any bug fix must land twice. Decide which
  ships as a product vs. which is an example.
- [x] ~~`GENKIT_ENV=dev` requirement.~~ Gone; box turns reflection on with
  `GENKIT_REFLECTION_ENABLED`.
- [ ] **Review the `initChannel` / `Channel` surface** (`src/lib/channel.ts`).
  Replaced `startAppProcess` + the hand-rolled reflection client. Open:
  whether `agentState` belongs in config or should come from box (FR-6), and
  whether `options` should be validated against a channel-declared schema.
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
- [ ] **Live tests (`pnpm test:live`) are not in CI.** They need GEMINI_API_KEY
  and a built `samples/discord-agent`.
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
- [x] ~~Is reflection-v2-over-loopback the shipping architecture?~~ The app
  now runs in a box (`@genkit-ai/box`); the transport is box's concern.
- [ ] Semver commitment: is `initChannel` considered stable API at 1.0, and
  what is the deprecation policy for `channels.yaml`?
