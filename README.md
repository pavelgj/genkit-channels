# genkit-channels (experimental)

Expose a Genkit app's flows and agents over a transport (a "channel").
`genkit-channels` runs your app as a child process and talks to it over
the reflection v2 protocol (JSON-RPC 2.0 over WebSocket), discovering its actions
at runtime and mapping them onto a transport such as plain HTTP, a Slack bot, or
a Discord bot.

Because the link is language-agnostic, one Node channel works against a JS, Go,
or Python app. This package is both a CLI and a small helper library that channel
authors build on.

For the rationale, architecture, and open questions, see
[docs/DESIGN.md](docs/DESIGN.md).

## Install

```bash
# from this repo, for local development
pnpm install
pnpm build
npm link            # exposes the `genkit-channels` binary on your PATH
```

## Concepts

- **Channel**: a small Node program that maps a transport onto a Genkit app's
  actions. Channels live under `.genkit/channels/<name>/` in your project and are
  installed with `genkit-channels add`.
- **Manifest** (`channels.yaml`): describes one or more deployments, each pairing
  a channel with a runtime (how to build/run your app) and an optional target.
- **Helper library** (`startAppProcess`): the reusable machinery a channel uses
  to spawn your app and speak reflection v2.

## CLI

```bash
# install channels from a source (owner/repo, GitHub URL, or local path)
genkit-channels add ./channels
genkit-channels add ./channels http      # just one
genkit-channels add owner/repo#main --dir channels

genkit-channels list
genkit-channels remove http
genkit-channels update [name]

# compose + run a deployment locally (no container)
genkit-channels deploy <name> --local

# compose the staging dir only
genkit-channels deploy <name> --build-only

# compose + ship to a target (e.g. Cloud Run)
genkit-channels deploy <name>
```

### channels.yaml

```yaml
deployments:
  - name: weather-http
    channel: http
    runtime:
      language: js
      build: pnpm build
      command: node
      args: [lib/index.js]
    expose:
      agent: weatherAgent
      flows: [weatherFlow]
    target: cloud-run
    region: us-central1
```

## Agents without a runtime (agent-dir)

For common agent use cases you do not need to write or run any Genkit app at all.
Drop a folder of agent prompts next to your `channels.yaml` and omit `runtime`:
the framework runs a built-in agent-dir runtime that loads the folder, installs
the default middleware (filesystem, skills, retry, artifacts, ...), and registers
each agent folder as an agent.

Folder convention:

```
agents/
  myAgent/
    agent.prompt          standard agent prompt (model, tools, use: middleware)
    skills/
      <skill>/SKILL.md    auto-wired into the skills middleware for this agent
channels.yaml
```

The agent folder name is the agent name (addressable at `/agent/myAgent`).

```yaml
deployments:
  - name: assistant
    channel: http
    # No runtime: the built-in agent-dir runtime loads ./agents.
    agents:
      dir: ./agents                         # default ./agents
      model: googleai/gemini-flash-latest   # default model for agents
    expose:
      agent: myAgent
```

Models "just work" once an API key is set: Google AI (`GEMINI_API_KEY`), OpenAI
(`OPENAI_API_KEY`), or Anthropic (`ANTHROPIC_API_KEY`). Only providers whose key
is present are registered.

### Custom tools, models, or middleware

When you need more than prompts and the defaults, bring a tiny runtime and let
`loadAgentDir` build the Genkit instance for you. It installs the defaults and
loads the agent folder, then returns the instance so you can keep configuring it:

```js
import { z } from 'genkit';
import { loadAgentDir } from 'genkit-channels/agent-dir';

const ai = loadAgentDir({ dir: './agents' /*, plugins: [ myProvider() ] */ });

// A custom tool an agent.prompt can reference by name in its `tools:` list.
ai.defineTool({ name: 'getWeather', /* ... */ }, async (input) => { /* ... */ });
```

Because the dir agents and your custom tools/models/middleware share one Genkit
registry, prompts resolve tools by name, and an agent you define yourself
overrides a same-named dir agent.

See `samples/agent-dir-basic/` (no runtime) and `samples/agent-dir-custom/`
(runtime with a custom tool).

## Writing a channel


A channel is a Node package with a `channel.yaml` and an entry module. It imports
`startAppProcess` from `genkit-channels` and maps a transport onto the discovered
actions. `startAppProcess()` is synchronous and self-configuring: it reads the
composed `channel.config.json` for you (managed vs attached mode, how to spawn
your app), so a channel writes almost no plumbing:

```js
import { startAppProcess } from 'genkit-channels';

const app = startAppProcess();                 // reads channel.config.json
const { expose } = await app.getConfig();      // resolved expose filter + options

const actions = await app.listActions();       // awaits readiness for you
const { result } = await app.runAction({ key: '/flow/foo', input });
// streaming:
await app.runAction({ key, input, onChunk: (c) => ... });
```

For chat channels that drive an agent, resolve one with `getAgent`:

```js
import { startAppProcess } from 'genkit-channels';

const app = startAppProcess();
const agent = await app.getAgent('weatherAgent'); // or omit for the sole agent
const turn = agent.chat({ sessionId }).sendStream('hello');
for await (const chunk of turn.stream) process.stdout.write(chunk.text);
```

See `channels/http/` (transport) and `channels/discord/` (agent) for complete
examples.


## How it runs

At deploy time the CLI composes a staging dir containing the channel, your app
source, and a `channel.config.json` describing how to build/run your app (the
"child") plus any `expose` filter. The channel reads that config, spawns the
child with `GENKIT_REFLECTION_V2_SERVER` set, waits for the child to `register`,
lists its actions, and serves them.

Note: the reflection v2 client only activates when the runtime runs with
`GENKIT_ENV=dev`, so the helper sets that on the child. The child must be
"headless" (register its actions and idle, without starting its own HTTP
transport) so it does not collide with the channel on `$PORT`.

## Overhead

A fair question about this model: the channel runs your app as a second process
and talks to it over a loopback reflection v2 hop, so what does that cost? We
measured it against a **real Genkit app** (`genkit.Init` + `DefineFlow`) serving
a trivial echo flow, so the numbers isolate the serving path from model latency.
Full methodology and results: [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

Headline numbers (Apple Silicon, loopback; deltas are the point, not absolutes):

| Metric              | Native Genkit | Go channel      | Node channel     |
| ------------------- | ------------- | --------------- | ---------------- |
| Latency p50         | 0.051 ms      | 0.106 ms        | 0.119 ms         |
| Added latency p50   | baseline      | +0.055 ms       | +0.068 ms        |
| Cold start (median) | 69.6 ms       | 101.6 ms        | 161.1 ms         |
| Added cold start    | baseline      | +32.0 ms        | +91.4 ms         |
| Idle RSS (+ child)  | 15.6 MB       | 28.2 MB         | 81.4 MB          |

What this means in practice:

- **Per-request cost is negligible.** The channel adds roughly **50-70
  microseconds** to a request. Against a real model call of hundreds of
  milliseconds to seconds, that is about 0.01% of the request, invisible in a
  trace unless you look for it.
- **Cold start adds a process spawn plus the register handshake.** For a compiled
  Go channel that is about 32 ms on top of the framework's own boot; for the Node
  channel about 91 ms (mostly Node runtime and module load). This is the number
  that matters most on scale-to-zero platforms like Cloud Run.
- **Memory is dominated by the channel's own runtime.** The Go channel plus its
  child idles around 28 MB; the Node channel plus the same child around 81 MB.

These channel numbers include the `GENKIT_ENV=dev` tax, since the child must run
in dev mode for the reflection v2 client to activate today. They are therefore
the honest end-to-end overhead a user would see, not a best case. A hardened,
`GENKIT_ENV`-independent serve mode would only shrink them.

What benchmarks cannot answer: reflection v2 is currently unauthenticated and
dev-oriented, so **security and API stability**, not performance, are the real
work before this is production-grade. See
[docs/DESIGN.md](docs/DESIGN.md#productionization--risks).

## Layout

```
genkit-channels/
  src/                      CLI + startAppProcess helper library
  channels/
    http/                   the bundled Node HTTP channel
    http-go/                the Go HTTP channel (small static binary)
  samples/
    discord-agent/          a Genkit agent wired to the Discord channel
    discord-agent-dir/      a runtime-less Discord bot (just a folder of prompts)
    agent-dir-basic/        a runtime-less agent (just a folder of prompts)
    agent-dir-custom/       an agent-dir runtime with a custom tool
  bench/                    overhead benchmark harness (real Genkit app)

  docs/                     DESIGN.md, BENCHMARKS.md
  test/                     smoke test + fake reflection v2 client
```


## Develop

```bash
pnpm build
pnpm smoke      # exercises startAppProcess against the fake runtime
```
