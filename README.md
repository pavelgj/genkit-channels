# genkit-channels (experimental)

Expose a Genkit app's flows and agents over a transport (a "channel") such as
plain HTTP, a Slack bot, or a Discord bot.

Your app runs in a box ([`@genkit-ai/box`](https://www.npmjs.com/package/@genkit-ai/box)):
a local subprocess by default, or an OS sandbox, a container, or an
already-running remote runtime. The channel drives it through proxies, so the
same channel code works whichever box you pick, and against a JS, Go, or Python
app. This package is both a CLI and a small helper library that channel authors
build on.

## Install

```bash
# from this repo, for local development
pnpm install
pnpm build
npm link            # exposes `genkit-channel` (alias `genkit-channels`) on your PATH
```

## Concepts

- **Channel**: a small Node program that maps a transport onto a Genkit app's
  actions. Channels live under `.genkit/channels/<name>/` in your project and are
  installed with `genkit-channel add`.
- **Channel manifest** (`channel.yaml`): written by the channel author.
  Entry point, build step, env vars the channel needs, recommended service
  settings, validation rules.
- **Channel configuration** (`channels.yaml`): written by you. One or more
  deployments, each pairing a channel with your app (`runtime`), what to
  `expose`, channel options (`with`), how the app is boxed (`box`), and an
  optional deploy target.
- **Helper library** (`initChannel`): what a channel calls to get proxies for
  your app's agents and flows. Apps import `genkit-channels/app` for
  app-side helpers such as `defineContextProvider`.

In these docs a bare "channel" always means the above. Slack and Discord
channels are always called "Slack channel" or "Discord channel".

## CLI

```bash
# install channels from a source (owner/repo, GitHub URL, or local path)
genkit-channel add ./channels
genkit-channel add ./channels http      # just one
genkit-channel add owner/repo#main --dir channels

genkit-channel list
genkit-channel remove http
genkit-channel update [name]

# run a deployment locally (no container); the name is optional with one deployment
genkit-channel dev <name>

# compose the staging dir only
genkit-channel deploy <name> --build-only

# compose + ship to a target (e.g. Cloud Run)
genkit-channel deploy <name>
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

`expose` is the source of truth for what the channel serves. Channels don't
ask the app what it has at runtime, because a boxed app may not be running yet.
Agents are server-managed (they have a session store) unless you say otherwise:

```yaml
    expose:
      agent: helper
      agentState:
        helper: client   # no store: the channel carries the conversation state
```

### Secrets

Secrets are env vars whose values the CLI never handles on a cloud deploy. The
channel declares what it needs in its `channel.yaml`; you declare what your app
needs on the deployment:

```yaml
# channels/discord/channel.yaml (channel author)
secrets: [DISCORD_TOKEN]
```

```yaml
# channels.yaml (you)
    secrets: [GEMINI_API_KEY]
```

Channel secrets go to the channel process only; app secrets go to the app
only. The box config is generated from that, so you don't repeat names in
`box.env`.

**Locally** (`dev`), values come from `.env` files in the project,
later files winning: `.env`, `.env.local`, `.env.<deployment>`,
`.env.<deployment>.local`. Variables already set in your shell win over all of
them. Keep real values in the `*.local` files and gitignore them. A missing
secret stops the run before anything starts:

```
Missing secrets:
  DISCORD_TOKEN   (channel discord)
  GEMINI_API_KEY  (app)
Add them to .env.local (or .env.discord-bot.local), or set them in your shell.
```

**On Cloud Run**, each secret is a Secret Manager secret of the same name
(latest version), injected by Cloud Run at startup. Before building, `deploy`
checks they exist (read-only) and, if any don't, stops and prints the
`gcloud secrets create ...` and access-grant commands to run. It never creates
secrets itself. With `--dry-run` the same check is reported as a warning.

Use a map when the platform name differs or to pin a version:

```yaml
    secrets:
      GEMINI_API_KEY: gemini-key@3
      DISCORD_TOKEN: projects/shared-prj/secrets/discord-token
```

Single-container packaging puts every secret in the one container's env (the
box still keeps channel secrets away from the app). Sidecar packaging gives
each container only its own.

Channels read their secrets with `channel.secret('DISCORD_TOKEN')`, which
throws a helpful error if it's missing; `initChannel()` checks all declared
secrets at startup. Plain `env:` on a deployment is for non-secret config and
is deployed as plain env vars (the CLI warns if a name looks like a secret).

### Boxing the app

The optional `box` block decides where and how your app runs. It maps directly
onto `@genkit-ai/box`, and the channel code doesn't change:

```yaml
    box:
      runner:
        type: exec            # exec (default) | podman | remote
        isolate: local        # none | local | bubblewrap | sandbox-exec
      route: session          # app (default, one box) | session | request
      idle: 10m               # reclaim idle boxes (session default 5m)
      env: []                 # only basics (PATH, HOME, ...) + the app's secrets
      warm: true              # start the app (or the shared box) at startup
```

- **exec** runs `runtime.command` as a local subprocess (the default).
  `isolate: local` jails it in seatbelt (macOS) or bubblewrap (Linux). That
  is a dev-time guardrail, not containment.
- **podman** runs it in a container (`image`, `network`, `extraArgs`, ...) with
  egress blocked by default.
- **remote** calls a runtime someone else started (`url`), e.g. the Cloud Run
  sidecar. The secret comes from `GENKIT_REFLECTION_SECRET_TOKEN`.
- **route: session** gives each agent conversation its own box, as long as the
  channel opens one handle per conversation (`channel.agent(name, { sessionId
  })`; the bundled channels do). Flows share one box. Pair it with a persistent
  session store if conversations must outlive `idle`.
- The channel's secrets (from its `channel.yaml`, e.g. `DISCORD_TOKEN`) are
  always withheld from the box unless you list them in `box.env`. The app's
  `secrets` are added to `box.env` automatically.

Each of these maps onto a `@genkit-ai/box` feature (`execRunner`,
`podmanRunner`, `remoteRunner`, `sessionRoute`, `inheritEnv`, `warm`).

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

## Authenticating callers (context providers)

The app decides who may call it. Define a context provider in the app and
select it by name on the deployment:

```ts
import { UserFacingError } from 'genkit';
import { defineContextProvider } from 'genkit-channels/app';

defineContextProvider(ai, { name: 'auth' }, async (req) => {
  const user = await verifyIdToken(req.headers['authorization']);
  if (!user) throw new UserFacingError('UNAUTHENTICATED', 'sign in first');
  return { auth: { uid: user.uid } };
});
```

```yaml
    expose:
      agent: helper
      contextProvider: auth
```

The channel runs the provider before every agent turn and flow call. What it
returns becomes the action context, so tools and flows read it as `context`:

```ts
ai.defineTool({ name: 'listMyNotes' /* ... */ }, async (_input, { context }) =>
  notesFor(context.auth?.uid)
);
```

The provider gets a `ChannelRequest`: `method`, `headers` (lowercase names) and
`input` from HTTP channels. Chat channels have no headers and describe the
caller in `channel` instead (`{ platform: 'slack', user: { id }, tenant }`).
Throw `UNAUTHENTICATED` or `PERMISSION_DENIED` to refuse: HTTP channels answer
401 or 403, chat channels reply with a short refusal. genkit's own providers fit
as is, for example `apiKey(process.env.API_KEY)` from `genkit/context`.

The provider runs in the app's shared box, so a refused caller never starts a
per-session box (`route: session`). Under `route: request` it costs a box start
per call, like any other call.

Go and Python apps: define a flow named `contextProvider/<name>` that takes a
`ChannelRequest` and returns a JSON object.

See `samples/http-auth/` for an agent and a flow behind API keys.

### Built-in providers (no app code)

Apps with nowhere to put a provider (agent-dir) can use a built-in one,
configured in YAML and run in the channel:

```yaml
    expose:
      agent: assistant
      contextProvider:
        apiKey: { secrets: [API_KEY, API_KEY_NEXT] }
```

`apiKey` accepts the `Authorization` header (with or without `Bearer `) when it
matches any listed secret, so a key can rotate without downtime. Tools see
`context.auth` as `{ provider: 'apiKey', keyName: 'API_KEY' }`, never the key.
The secrets are the channel's: they are checked at startup, kept out of the
app's box, and come from `.env.local` or Secret Manager like any other. A
refused caller never starts the app. Chat channels (Slack, Discord) send no
headers and reject this provider at deploy time.

See `samples/agent-dir-basic/`.

## Writing a channel


A channel is a Node package with a `channel.yaml` and an entry module. It calls
`initChannel()`, which reads the deployment config and hands back proxies.
Everything is synchronous: no process starts until the first call.

```ts
import { initChannel } from 'genkit-channels';

interface MyOptions {
  greeting?: string;
}

const channel = initChannel<MyOptions>();
const { expose, options } = channel; // from channels.yaml (`expose`, `with`)

// Agents: a standard AgentAPI (chat, sendStream, getSnapshot, abort).
// One handle per conversation (they're cheap): with `box.route: session`, every
// call through it goes to that conversation's box.
const agent = channel.agent(expose.agents[0], { sessionId });
const turn = agent.chat({ sessionId }).sendStream('hello');
for await (const chunk of turn.stream) process.stdout.write(chunk.text);
const res = await turn.response;

// Client-managed agents: round-trip the state yourself.
if (channel.agentState(expose.agents[0]) === 'client') {
  const next = agent.chat({ state: res.raw.state });
}

// Flows: a regular Genkit action. Cancel with an AbortSignal.
const ac = new AbortController();
const { stream, output } = channel.flow('summarize').stream(input, {
  abortSignal: ac.signal,
});

// On shutdown: stop every box the channel started.
await channel.close();
```

Run the app's context provider for every incoming call and pass the result on.
`channel.context()` resolves to `{}` when the deployment has none, so always
call it:

```ts
import { httpStatusFor, isAuthError } from 'genkit-channels';

// HTTP: method, headers, body.
try {
  const context = await channel.context({ method: req.method, headers: req.headers, input: req.body });
  const agent = channel.agent(name, { sessionId, context });
  // ...
} catch (e) {
  res.status(httpStatusFor(e)).json({ error: { message: String(e) } }); // 401, 403, 400, ..., 500
}

// Chat: no headers, describe the caller instead.
const context = await channel.context({
  input: text,
  channel: { platform: 'slack', user: { id: userId }, tenant: teamId },
});
// On a refusal, isAuthError(e) is true: reply with a short "not allowed".
```

A few more things are available when you need them:

- `channel.secret(name)` reads a secret declared in `channel.yaml` (`secrets:`)
  and throws a helpful error if it isn't set.
- `channel.warm()` starts the app now rather than on the first call.
- `channel.listActions()` asks the app what it has. It is opt-in and may start
  a box just to answer.
- `channel.box` / `channel.ai` expose the underlying box and Genkit instance.
- `initChannel({ config, runner })` takes the config inline or a custom
  `BoxRunner`, which is handy for tests.

See `channels/http/` (flows and agents over HTTP), `channels/slack-socket/`
(a Slack bot, with its pure logic split out for tests) and `channels/discord/`
(one agent as a bot) for complete examples.


## How it runs

At deploy time the CLI composes a staging dir with the channel, your app
source, and a `channel.config.json`: the deployment from `channels.yaml` with
defaults filled in (the box runner command comes from `runtime`, paths are
resolved, and the channel's env vars are withheld from the box). Users never
edit this file; `initChannel()` reads it.

At runtime the channel's box starts your app on demand. With the exec runner
the app dials back over reflection v2. With podman or remote, the channel calls
the app's v1 reflection server. Either way the link is authenticated with a
per-box secret, and reflection is turned on with `GENKIT_REFLECTION_ENABLED`
(not `GENKIT_ENV=dev`), so the app keeps production defaults.

Requirements on your app:

- **genkit 1.43 or newer** (JS), or a Go/Python runtime that honors
  `GENKIT_REFLECTION_ENABLED` and `GENKIT_REFLECTION_SECRET_TOKEN`. Older
  runtimes don't present the secret and are rejected.
- **Headless**: register actions and idle, without starting your own HTTP
  server, so it doesn't collide with the channel on `$PORT`.

On Cloud Run, `single-container` packaging boxes the app as a subprocess in
the channel's container. `sidecar` runs the app in its own container serving
reflection on loopback, and the channel reaches it with a `remote` runner.

## Layout

```
genkit-channels/
  src/                      CLI + initChannel helper library
  channels/
    http/                   flows and agents over HTTP
    discord/                one agent as a Discord gateway bot
    slack-socket/           one agent as a Slack bot (Socket Mode)
  samples/
    discord-agent/          a Genkit agent wired to Discord and Slack
    discord-agent-dir/      a runtime-less Discord bot (just a folder of prompts)
    agent-dir-basic/        a runtime-less agent (just a folder of prompts)
    agent-dir-custom/       an agent-dir runtime with a custom tool
    http-auth/              an agent and a flow behind a context provider (API keys)
  test/                     tests, a fake reflection runtime, a real echo app
```

## Develop

```bash
pnpm build
pnpm test       # no API keys or containers needed

# against Gemini (needs GEMINI_API_KEY and samples/discord-agent built once)
pnpm test:live
```
