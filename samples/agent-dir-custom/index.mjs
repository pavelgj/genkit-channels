/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A custom agent-dir runtime.
 *
 * `loadAgentDir` builds the Genkit instance for us: default middleware, model
 * providers (by API key), and every agent under ./agents. It returns the
 * instance, so we can keep configuring it, here by adding a custom tool that the
 * agent prompt references by name.
 *
 * This is the escape hatch from the zero-code path: anything you can do with a
 * hand-written Genkit runtime you can do here, while still getting the agent
 * folder and defaults for free. Add extra plugins via `loadAgentDir({ plugins })`.
 */

import { z } from 'genkit';
import { loadAgentDir } from 'genkit-channels/agent-dir';

const ai = loadAgentDir({
  dir: './agents',
  // Add extra model providers or plugins here if you need them:
  // plugins: [ myProvider() ],
});

// A custom tool. The agent's prompt lists `getWeather` in its `tools:`, and
// because the dir agents and this tool share one registry, it resolves by name.
ai.defineTool(
  {
    name: 'getWeather',
    description: 'Get the current weather for a location.',
    inputSchema: z.object({ location: z.string() }),
    outputSchema: z.object({ weather: z.string() }),
  },
  async ({ location }) => {
    // Replace with a real API call. Kept deterministic for the sample.
    return { weather: `Sunny in ${location}, around 21C.` };
  }
);

console.log('[weather] custom agent-dir runtime up');

// Stay alive (headless): the channel drives us over reflection v2.
setInterval(() => {}, 1 << 30);
