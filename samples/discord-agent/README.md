# Discord agent sample

A minimal Genkit agent wired to Discord with `genkit-channels`. The app defines
one agent (`weatherAgent`) with a single tool; the Discord channel discovers it
over reflection v2 and runs it as a gateway bot. There is no bot code in this
sample, only the agent. The transport is entirely the channel's job.

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

cp .env.example .env
# then edit .env and fill in DISCORD_TOKEN and GEMINI_API_KEY
```

Install the Discord channel into this project (points at the channels dir in
this repo; you can also use an `owner/repo` or a GitHub URL):

```bash
genkit-channels add ../../channels discord
```

## Run it locally

```bash
genkit-channels deploy discord-bot --local
```

This builds the app, spawns it as a headless child, and connects the bot to
Discord. Once you see `ready as <bot>#1234`, DM the bot or mention it in a
channel it can see:

```
@yourbot what's the weather in Tokyo?
```

The bot streams the agent's reply back as it generates, editing a single message
as text arrives.

## How it fits together

- `agent.ts` defines `weatherAgent` with a `store`, which makes it
  server-managed: conversation history lives on the server keyed by session id.
  The channel maps each Discord thread (or DM) to a stable session id, so
  conversations stay separate. Remove the `store` to make it client-managed
  instead; the channel then round-trips the state blob per conversation.
- `channels.yaml` binds the agent to the `discord` channel and sets a couple of
  channel options under `with`. See `channels/discord/channel.yaml` in this repo
  for the full list and the service settings a gateway bot recommends.

## Deploy to Cloud Run

A gateway bot holds an outbound WebSocket, so it needs a warm instance with CPU
always allocated (the channel recommends this automatically). Add a target to
the deployment in `channels.yaml`:

```yaml
    target: cloud-run
    region: us-central1
```

then run `genkit-channels deploy discord-bot` (without `--local`). Set
`DISCORD_TOKEN` and your model key as service env vars or secrets on the target.
