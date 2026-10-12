# agent-dir-basic

A Genkit agent with **no runtime code**: just a folder of agent prompts. This is
the simplest way to ship an agent through a channel. The framework runs a
built-in runtime that loads `./agents`, installs the default middleware
(filesystem, skills, retry, ...), and registers each agent folder as an agent.

## Layout

```
agents/
  assistant/
    agent.prompt          the agent's prompt (model, config, use: middleware)
    skills/
      pirate/SKILL.md     a skill, auto-wired into the skills middleware
channels.yaml             wires the agent folder to the http channel
.env.example              the secrets to put in .env.local
```

The agent folder name (`assistant`) becomes the agent name, addressable at
`/agent/assistant`.

## Run it

Models "just work" once an API key is set. Google AI (Gemini) needs
`GEMINI_API_KEY`; OpenAI needs `OPENAI_API_KEY`; Anthropic needs
`ANTHROPIC_API_KEY`. Only providers with a key present are registered.

```bash
# Install the HTTP channel into this project.
genkit-channel add ../../channels http

# Secrets: the model key, and the key callers must present.
cp .env.example .env.local   # fill in GEMINI_API_KEY and API_KEY

# Run locally (no container).
genkit-channel dev assistant
```

Then, in another terminal:

```bash
KEY=...   # the API_KEY from .env.local

# Non-streaming turn.
curl -s localhost:8080/assistant \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"message":"hello!"}'

# Ask it to use the pirate skill.
curl -s localhost:8080/assistant \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"message":"talk like a pirate"}'

# No key: 401. Wrong key: 403.
curl -s -w ' [%{http_code}]\n' localhost:8080/assistant \
  -H 'content-type: application/json' -d '{"message":"hi"}'
```

## Auth without code

There's no app code to put a context provider in, so the deployment uses the
built-in `apiKey` provider:

```yaml
expose:
  agent: assistant
  contextProvider:
    apiKey: { secrets: [API_KEY] }
```

The channel checks the `Authorization` header (with or without `Bearer `)
before the app starts, so a refused caller costs nothing, and the key never
reaches the app. To rotate, list both keys, move callers to the new one, then
drop the old one:

```yaml
    apiKey: { secrets: [API_KEY, API_KEY_NEXT] }
```

On Cloud Run the keys come from Secret Manager like any other secret.

## Customizing

- Change the model per agent in the prompt frontmatter (`model:`), or set a
  default for all agents in `channels.yaml` under `agents.model`.
- Add more agents by adding more folders under `agents/`.
- Add more skills by adding folders under an agent's `skills/`.
- Need custom tools, models, or middleware? See `../agent-dir-custom`, which
  brings its own tiny runtime via `loadAgentDir`.
