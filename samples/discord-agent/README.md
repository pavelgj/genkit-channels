# Discord agent sample

A minimal Genkit agent wired to Discord with `genkit-channels`. The app defines
one agent (`weatherAgent`) with a single tool; the Discord channel runs it as a
gateway bot, with the app itself in a box (`@genkit-ai/box`). There is no bot
code in this sample, only the agent. The transport is entirely the channel's
job.

## Layout

```
discord-agent/
  channels.yaml        wires weatherAgent to the discord channel
  src/
    genkit.ts          the shared Genkit instance (model + plugins)
    agent.ts           weatherAgent + its getWeather tool
    index.ts           entry point; imports the agent to register it
  .env.example         DISCORD_TOKEN + model credentials
```

## Prerequisites

- Node 20+ and `genkit-channels` on your PATH (from the repo root: `pnpm install
  && pnpm build && npm link`).
- A Discord application with a bot. In the developer portal create an app, add a
  bot, copy its token, and enable the **Message Content** privileged intent
  (Bot -> Privileged Gateway Intents). Invite the bot to a server with the
  `bot` scope and permission to read and send messages.
- A model provider key. This sample uses Google AI (Gemini); get one at
  https://aistudio.google.com/apikey.

## Setup

```bash
cd samples/discord-agent
npm install

cp .env.example .env.local
# then edit .env.local and fill in DISCORD_TOKEN and GEMINI_API_KEY
```

Install the Discord channel into this project (points at the channels dir in
this repo; you can also use an `owner/repo` or a GitHub URL):

```bash
genkit-channel add ../../channels discord
```

## Run it locally

```bash
genkit-channel dev discord-bot
```

This connects the bot to Discord; the app starts headless in its box on the
first message (build it first with `npm run build`). Once you see `ready as <bot>#1234`, DM the bot or mention it in a
channel it can see:

```
@yourbot what's the weather in Tokyo?
```

The bot streams the agent's reply back as it generates, editing a single message
as text arrives.

## Slack too

The same agent also runs as a Slack bot (the `slack-bot` deployment, using the
`slack-socket` channel). Create the Slack app as described in
[`channels/slack-socket/README.md`](../../channels/slack-socket/README.md), put
`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `.env.local`, then:

```bash
genkit-channel add ../../channels slack-socket
genkit-channel dev slack-bot
```

Mention the bot in a Slack channel it was invited to, or DM it.

## How it fits together

- `agent.ts` defines `weatherAgent` with a `store`, which makes it
  server-managed: conversation history lives on the server keyed by session id.
  The channel maps each Discord thread (or DM) to a stable session id, so
  conversations stay separate. Remove the `store` to make it client-managed
  instead; the channel then round-trips the state blob per conversation.
- `channels.yaml` binds the agent to the `discord` channel and sets a couple of
  channel options under `with`. See `channels/discord/channel.yaml` in this repo
  for the full list and the service settings a gateway bot recommends.
- The `box` block in `channels.yaml` decides where the app runs. The bot code
  never changes; only the config does.

## Boxing options

Everything below is a `box:` block on the deployment.

Only hand the app the basics plus its own secrets (`env: []`; the app's
`secrets` are added for you, and the channel's `DISCORD_TOKEN` is withheld
either way):

```yaml
box:
  env: []
```

Jail it in an OS sandbox (macOS seatbelt / Linux bubblewrap). This guards
against accidents; it is not containment for hostile code:

```yaml
box:
  env: []
  runner: { type: exec, isolate: local }
```

One box per Discord conversation, reclaimed when idle. The agent's
`FileSessionStore` keeps history on disk, so a reclaimed conversation picks up
where it left off:

```yaml
box:
  route: session
  idle: 10m
```

Run it in a container with no internet access except what you allow (needs
podman or docker; build the app first so `lib/` exists, and prime a
Linux `node_modules` volume as described in the `@genkit-ai/box` README):

```yaml
box:
  # Containers start with no host env; the app's `secrets` are passed in.
  runner:
    type: podman
    image: node:22-slim
    network: bridge        # the agent calls Gemini, so it needs egress
    modulesVolume: discord-agent-modules
    extraArgs: ['--memory=512m']
```

## Deploy to Cloud Run

A gateway bot holds an outbound WebSocket, so it needs a warm instance with CPU
always allocated (the channel recommends this automatically). Add a target to
the deployment in `channels.yaml`:

```yaml
    target: cloud-run
    region: us-central1
```

then run `genkit-channel deploy discord-bot`.

`DISCORD_TOKEN` (declared by the channel) and `GEMINI_API_KEY` (declared under
`secrets` in `channels.yaml`) are read from Secret Manager secrets of the same
names. The deploy checks they exist before building; if one is missing it stops
and prints the `gcloud secrets create ...` and access-grant commands to run.
The CLI never creates secrets itself.
