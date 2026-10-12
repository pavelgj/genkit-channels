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
 * A Genkit app whose callers are authenticated by a context provider.
 *
 * The channel (here, HTTP) runs `apiKey` on every request and passes what it
 * returns as action context, so the agent's tools and the flow know who is
 * calling. The app never sees the HTTP request itself.
 */

import { googleAI } from '@genkit-ai/google-genai';
import { UserFacingError, z } from 'genkit';
import { genkit } from 'genkit/beta';
import { defineContextProvider } from 'genkit-channels/app';

const ai = genkit({
  plugins: [googleAI()],
  model: googleAI.model('gemini-flash-latest'),
});

// API key -> user, from the API_KEYS secret ("alice:key-1,bob:key-2"). A real
// app would verify a token instead (Firebase Auth, your identity provider).
const users = new Map(
  (process.env.API_KEYS ?? '')
    .split(',')
    .map((pair) => pair.trim().split(':'))
    .filter(([uid, key]) => uid && key)
    .map(([uid, key]) => [key, uid])
);

// Selected with `expose.contextProvider: apiKey` in channels.yaml. Throwing
// UNAUTHENTICATED / PERMISSION_DENIED makes the HTTP channel answer 401 / 403.
defineContextProvider(ai, { name: 'apiKey' }, async (req) => {
  const header = req.headers['authorization'] ?? '';
  const key = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!key) {
    throw new UserFacingError('UNAUTHENTICATED', 'send Authorization: Bearer <api key>');
  }
  const uid = users.get(key);
  if (!uid) throw new UserFacingError('PERMISSION_DENIED', 'unknown API key');
  return { auth: { uid } };
});

const notes = {
  alice: ['Dentist on Tuesday at 10', 'Buy oat milk'],
  bob: ['Renew passport', 'Call the plumber about the kitchen sink'],
};

// Tools get the caller's context too: each user only sees their own notes.
const listMyNotes = ai.defineTool(
  {
    name: 'listMyNotes',
    description: "Lists the current user's notes.",
    inputSchema: z.object({}),
    outputSchema: z.array(z.string()),
  },
  async (_input, { context }) => notes[context.auth?.uid] ?? []
);

ai.defineAgent({
  name: 'notesAgent',
  system:
    "You help the user with their notes. Use listMyNotes to read them. Keep " +
    'answers short.',
  tools: [listMyNotes],
});

ai.defineFlow(
  { name: 'whoami', outputSchema: z.object({ uid: z.string() }) },
  async (_input, { context }) => ({ uid: context.auth?.uid ?? 'anonymous' })
);

// Headless: the channel drives the app over reflection.
setInterval(() => {}, 1 << 30);
