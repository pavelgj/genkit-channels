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
channels.yaml             wires the agent folder to the http-ts channel
```

The agent folder name (`assistant`) becomes the agent name, addressable at
`/agent/assistant`.

## Run it

Models "just work" once an API key is set. Google AI (Gemini) needs
`GEMINI_API_KEY`; OpenAI needs `OPENAI_API_KEY`; Anthropic needs
`ANTHROPIC_API_KEY`. Only providers with a key present are registered.

```bash
# Install the HTTP (TypeScript) channel into this project.
genkit-channel add ../../channels http-ts

# Run locally (no container). Loads the API key from your shell.
. ~/init-gemini.sh && genkit-channel deploy assistant --local
```

Then, in another terminal:

```bash
# Non-streaming turn.
curl -s localhost:8080/assistant \
  -H 'content-type: application/json' \
  -d '{"data":{"message":{"role":"user","content":[{"text":"hello!"}]}}}'

# Ask it to use the pirate skill.
curl -s localhost:8080/assistant \
  -H 'content-type: application/json' \
  -d '{"data":{"message":{"role":"user","content":[{"text":"talk like a pirate"}]}}}'
```

## Customizing

- Change the model per agent in the prompt frontmatter (`model:`), or set a
  default for all agents in `channels.yaml` under `agents.model`.
- Add more agents by adding more folders under `agents/`.
- Add more skills by adding folders under an agent's `skills/`.
- Need custom tools, models, or middleware? See `../agent-dir-custom`, which
  brings its own tiny runtime via `loadAgentDir`.
