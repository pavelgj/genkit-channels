# agent-dir-custom

The agent folder, plus a **custom runtime** that adds a tool. This is the escape
hatch from the zero-code path: you keep the folder-of-prompts convention and the
default middleware/model wiring, but you also get a real Genkit instance you can
extend with your own tools, models, and plugins.

The key is `loadAgentDir`: it builds the Genkit instance (default middleware,
model providers by API key, and every agent under `./agents`) and returns it, so
you can keep configuring it:

```js
import { z } from 'genkit';
import { loadAgentDir } from 'genkit-channels/agent-dir';

const ai = loadAgentDir({ dir: './agents' /*, plugins: [ myProvider() ] */ });

ai.defineTool({ name: 'getWeather', /* ... */ }, async ({ location }) => { /* ... */ });
```

Because the dir agents and your custom tool share one registry, an
`agent.prompt` can reference the tool by name:

```
---
tools:
  - getWeather
---
{{role "system"}}
You are a friendly weather assistant...
```

## Layout

```
index.mjs                 the custom runtime (loadAgentDir + a custom tool)
agents/
  weatherer/
    agent.prompt          references the getWeather tool by name
channels.yaml             wires the runtime + agent folder to the http-ts channel
package.json
```

## Run it

```bash
genkit-channel add ../../channels http-ts
npm install
. ~/init-gemini.sh && genkit-channel deploy weather --local
```

Then:

```bash
curl -s localhost:8080/weatherer \
  -H 'content-type: application/json' \
  -d '{"data":{"message":{"role":"user","content":[{"text":"what is the weather in Paris?"}]}}}'
```

## When to use which

- Just prompts and the basics (filesystem, skills, a model)? Use the
  zero-code path in `../agent-dir-basic` (no `runtime`, no code).
- Need custom tools, extra model providers, or custom middleware config? Bring a
  runtime like this one and call `loadAgentDir`.
