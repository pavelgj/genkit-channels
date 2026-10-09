# Discord agent-dir sample

A Discord bot with **no runtime code**: just a folder of agent prompts. The
framework runs the built-in agent-dir runtime, which loads `./agents`, installs
the default middleware (filesystem, skills, retry, ...), and registers each
agent folder as an agent. The Discord channel runs it as a gateway bot.

Compare with `../discord-agent`, which does the same thing but with a
hand-written Genkit app. Here there is no `src/`, no `package.json`, no code, the
agent is entirely defined by `agents/concierge/agent.prompt`.

## Layout

```
discord-agent-dir/
  channels.yaml                       wires the agent folder to the discord channel
  agents/
    concierge/
      agent.prompt                    the agent (config + use: skills)
      skills/
        standup/SKILL.md              a skill, auto-wired into the skills middleware
  .env.example                        DISCORD_TOKEN + model key
```

The agent folder name (`concierge`) is the agent name.

## Prerequisites

- Node 20+ and `genkit-channel` on your PATH (from the repo root: `pnpm install
  && pnpm build && npm link`).
- A Discord application with a bot. In the developer portal create an app, add a
  bot, copy its token, and enable the **Message Content** privileged intent
  (Bot -> Privileged Gateway Intents). Invite the bot to a server with the
  `bot` scope and permission to read and send messages.
- A model provider key. This sample uses Google AI (Gemini); get one at
  https://aistudio.google.com/apikey. Only providers whose key is set are
  registered, so `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` work too (set the
  matching `model:` in `channels.yaml`).

## Setup

```bash
cd samples/discord-agent-dir
cp .env.example .env
# then edit .env and fill in DISCORD_TOKEN and GEMINI_API_KEY

# Install the Discord channel into this project.
genkit-channel add ../../channels discord
```

## Run it locally

```bash
genkit-channel deploy discord-bot --local
```

This spawns the built-in agent-dir runtime as a headless child and connects the
bot to Discord. Once you see `ready as <bot>#1234`, DM the bot or mention it in a
channel it can see:

```
@yourbot can you run a standup for the team?
```

The bot streams the agent's reply back as it generates, editing a single message
as text arrives.

## Customizing

- Change the model per agent in the prompt frontmatter (`model:`), or set a
  default for all agents in `channels.yaml` under `agents.model`.
- Add more agents by adding more folders under `agents/` (and set `expose.agent`
  to pick which one the bot drives).
- Add more skills by adding folders under an agent's `skills/`.
- Need custom tools, models, or middleware? See `../agent-dir-custom`, which
  brings a tiny runtime via `loadAgentDir` and adds a custom tool.

## Deploy to Cloud Run

A gateway bot holds an outbound WebSocket, so it needs a warm instance with CPU
always allocated (the channel recommends this automatically). Add a target to
the deployment in `channels.yaml`:

```yaml
    target: cloud-run
    region: us-central1
```

then run `genkit-channel deploy discord-bot` (without `--local`). Set
`DISCORD_TOKEN` and your model key as service env vars or secrets on the target.
