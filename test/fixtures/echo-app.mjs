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

import { UserFacingError, z } from 'genkit';
import { genkit, InMemorySessionStore } from 'genkit/beta';
import { defineContextProvider } from '../../dist/app/index.js';

const ai = genkit({});

// `Bearer ok` passes; no header is UNAUTHENTICATED, a wrong one
// PERMISSION_DENIED.
defineContextProvider(ai, { name: 'auth' }, async (req) => {
  const header = req.headers['authorization'];
  if (!header) throw new UserFacingError('UNAUTHENTICATED', 'sign in first');
  if (header !== 'Bearer ok') throw new UserFacingError('PERMISSION_DENIED', 'not you');
  return { auth: { uid: req.channel?.user?.id ?? 'http-user' }, method: req.method };
});

// Returns the action context the call carried (auth from the provider).
ai.defineFlow({ name: 'whoami' }, async (_input, { context }) => ({ context }));

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

// No store: client-managed, the caller carries the state.
ai.defineAgent({
  name: 'echoClientAgent',
  system: 'You echo.',
  model: echoModel,
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
