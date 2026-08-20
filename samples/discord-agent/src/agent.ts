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

import { FileSessionStore } from 'genkit/beta';
import { z } from 'zod';
import { ai } from './genkit.js';
import { retry } from '@genkit-ai/middleware';

// A trivial tool so the agent can do something beyond chatting. Replace the
// body with a real lookup (an API call, a database query, etc.).
export const getWeather = ai.defineTool(
  {
    name: 'getWeather',
    description: 'Get the current weather for a given location.',
    inputSchema: z.object({ location: z.string() }),
    outputSchema: z.object({ weather: z.string() }),
  },
  async ({ location }) => {
    return { weather: `Sunny in ${location}, around 21C.` };
  }
);

// The agent the Discord channel drives. A `store` makes this server-managed:
// history is kept on the server keyed by session id, so the channel only has to
// pass a stable session id per conversation. Drop `store` to make it
// client-managed instead (the channel then round-trips the state blob).
export const weatherAgent = ai.defineAgent({
  name: 'weatherAgent',
  description: 'A friendly assistant that answers weather questions.',
  system:
    'You are a friendly assistant in a Discord chat. Keep replies short and ' +
    'conversational. Use the getWeather tool when asked about the weather.',
  tools: [getWeather],
  store: new FileSessionStore('./.snapshots'),
  use: [retry()],
});
