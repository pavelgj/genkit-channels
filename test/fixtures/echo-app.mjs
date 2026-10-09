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
 * A real (if tiny) headless Genkit app for tests: an echo model so no API key
 * is needed, a server-managed agent, and a streaming flow. Reflection is
 * turned on by whoever starts it (a box runner sets GENKIT_REFLECTION_*).
 */

import { z } from 'genkit';
import { genkit, InMemorySessionStore } from 'genkit/beta';

const ai = genkit({});

const echoModel = ai.defineModel({ name: 'echo' }, async (req, sendChunk) => {
  const last = req.messages.at(-1);
  const text = last?.content.map((p) => p.text ?? '').join('') ?? '';
  sendChunk?.({ content: [{ text: 'echo:' }] });
  sendChunk?.({ content: [{ text }] });
  return {
    finishReason: 'stop',
    message: { role: 'model', content: [{ text: `echo:${text}` }] },
  };
});

ai.defineAgent({
  name: 'echoAgent',
  system: 'You echo.',
  model: echoModel,
  store: new InMemorySessionStore(),
});

ai.defineFlow(
  {
    name: 'countTo',
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ total: z.number() }),
    streamSchema: z.object({ i: z.number() }),
  },
  async ({ n }, { sendChunk }) => {
    for (let i = 1; i <= n; i++) sendChunk({ i });
    return { total: n };
  }
);

// Headless: stay alive while the box drives us over reflection.
setInterval(() => {}, 1 << 30);
