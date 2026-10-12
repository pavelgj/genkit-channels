# Work plan

Sorted, top to bottom. Details live in the GitHub issues (tracking issue [#41](https://github.com/genkit-ai/genkit-channels/issues/41)).

## Decide first

- [x] [#3](https://github.com/genkit-ai/genkit-channels/issues/3) Decide: naming ("channel") and the local run command. Kept "channel"; CLI is `genkit-channel` (alias `genkit-channels`); local run is `genkit-channel dev <name>`
- [ ] [#4](https://github.com/genkit-ai/genkit-channels/issues/4) Decide: launch matrix (channels, runtimes, targets)
- [ ] [#5](https://github.com/genkit-ai/genkit-channels/issues/5) Decide: semver and deprecation policy for `initChannel` and `channels.yaml`

## Release blockers

- [x] [#6](https://github.com/genkit-ai/genkit-channels/issues/6) Fix `bin` path, add LICENSE, use one CLI name
- [x] [#7](https://github.com/genkit-ai/genkit-channels/issues/7) README links to docs/ and bench/ that don't exist. Dropped the Overhead section until benchmarks are re-measured on box
- [ ] [#8](https://github.com/genkit-ai/genkit-channels/issues/8) CI: build and tests on PRs, live tests on a schedule
- [ ] [#9](https://github.com/genkit-ai/genkit-channels/issues/9) Publish the `genkit-channels` library to npm; channels declare compatible versions

## P0

- [x] [#10](https://github.com/genkit-ai/genkit-channels/issues/10) Context providers: `defineContextProvider` shim and `expose.contextProvider`
- [ ] [#11](https://github.com/genkit-ai/genkit-channels/issues/11) HTTP channel: auth via context providers; merge `http` and `http-ts`
- [ ] [#12](https://github.com/genkit-ai/genkit-channels/issues/12) Chat channel basics: split long replies, per-thread queue in Discord, specific errors
- [ ] [#13](https://github.com/genkit-ai/genkit-channels/issues/13) Durable conversation state for client-managed agents
- [ ] [#14](https://github.com/genkit-ai/genkit-channels/issues/14) `genkit-channel check`, JSON Schema and spec for `channels.yaml`
- [ ] [#15](https://github.com/genkit-ai/genkit-channels/issues/15) `update` and `outdated`: versioned, reproducible channel updates from GitHub
- [ ] [#16](https://github.com/genkit-ai/genkit-channels/issues/16) Human-in-the-loop: turn events, interrupts and tool approval in channels

## P1

- [ ] [#17](https://github.com/genkit-ai/genkit-channels/issues/17) MCP server channel
- [ ] [#18](https://github.com/genkit-ai/genkit-channels/issues/18) AI SDK `useChat` / AG-UI channel
- [ ] [#19](https://github.com/genkit-ai/genkit-channels/issues/19) Shared chat toolkit (`genkit-channels/chat`)
- [ ] [#20](https://github.com/genkit-ai/genkit-channels/issues/20) Attachments in and out (multimodal input, artifacts output)
- [ ] [#21](https://github.com/genkit-ai/genkit-channels/issues/21) Typed `with` options from a channel-declared schema
- [ ] [#22](https://github.com/genkit-ai/genkit-channels/issues/22) Observability and robustness: trace links, box lifecycle, log tagging, drain
- [ ] [#23](https://github.com/genkit-ai/genkit-channels/issues/23) slack-webhook channel (Events API, Assistant panel)
- [ ] [#24](https://github.com/genkit-ai/genkit-channels/issues/24) More deploy targets: generic container, Firebase App Hosting; channel `image` field
- [ ] [#25](https://github.com/genkit-ai/genkit-channels/issues/25) Prove the Python runtime end to end (or mark it experimental)
- [ ] [#26](https://github.com/genkit-ai/genkit-channels/issues/26) A2A channel
- [ ] [#27](https://github.com/genkit-ai/genkit-channels/issues/27) OpenAI-compatible chat completions channel
- [ ] [#28](https://github.com/genkit-ai/genkit-channels/issues/28) Gemini Agent Platform Agent Runtime channel

## P2

- [ ] [#29](https://github.com/genkit-ai/genkit-channels/issues/29) `console` channel; restart on change for `genkit-channel dev`
- [ ] [#30](https://github.com/genkit-ai/genkit-channels/issues/30) `genkit-channel init` scaffolding
- [ ] [#31](https://github.com/genkit-ai/genkit-channels/issues/31) Non-chat channels for flows: cron, incoming webhooks, email
- [ ] [#32](https://github.com/genkit-ai/genkit-channels/issues/32) Proactive messages (`channel.notify`)
- [ ] [#33](https://github.com/genkit-ai/genkit-channels/issues/33) Feedback buttons linked to traces
- [ ] [#34](https://github.com/genkit-ai/genkit-channels/issues/34) Several agents per bot; several channels per service
- [ ] [#35](https://github.com/genkit-ai/genkit-channels/issues/35) In-process mode (box optional) for JS apps
- [ ] [#36](https://github.com/genkit-ai/genkit-channels/issues/36) Secrets on more targets; custom service account
- [ ] [#37](https://github.com/genkit-ai/genkit-channels/issues/37) Go channels (once box has a Go port)

## Upstream

- [ ] [#38](https://github.com/genkit-ai/genkit-channels/issues/38) Track open `@genkit-ai/box` feature requests

## Cleanup

- [ ] [#39](https://github.com/genkit-ai/genkit-channels/issues/39) Repo cleanup: .gitignore, package metadata, lint/format

## Release

- [ ] [#40](https://github.com/genkit-ai/genkit-channels/issues/40) Release checklist
