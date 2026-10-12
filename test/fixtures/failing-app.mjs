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
 * A Genkit app whose agents fail in the ways a real model does, for
 * test/failures.mjs: one agent per failure, each on a fake model. With
 * FAIL_ON_START=1 the app exits before it ever connects.
 */

import { GenkitError } from 'genkit';
import { genkit, InMemorySessionStore } from 'genkit/beta';

if (process.env.FAIL_ON_START === '1') {
  console.error('failing-app: exiting on start');
  process.exit(3);
}

const ai = genkit({});

/** A model that sends `chunks` and then behaves as `finish` says. */
function fakeModel(name, finish, chunks = []) {
  return ai.defineModel({ name }, async (_req, sendChunk) => {
    for (const text of chunks) sendChunk?.({ content: [{ text }] });
    return finish();
  });
}

const models = {
  // What a provider plugin throws on HTTP 429 / quota.
  rateLimited: fakeModel('rateLimited', () => {
    throw new GenkitError({ status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for model' });
  }),
  // A safety block: genkit turns this into GenerationBlockedError.
  blocked: fakeModel('blocked', () => ({
    finishReason: 'blocked',
    finishMessage: 'SAFETY',
    message: { role: 'model', content: [] },
  })),
  // A missing API key, the way plugins report it.
  misconfigured: fakeModel('misconfigured', () => {
    throw new GenkitError({ status: 'FAILED_PRECONDITION', message: 'Please pass in the API key' });
  }),
  // Fails after streaming part of the reply.
  midStream: fakeModel(
    'midStream',
    () => {
      throw new Error('connection reset by model');
    },
    ['partial ', 'reply']
  ),
  // A plain bug in the app.
  crashes: fakeModel('crashes', () => {
    throw new TypeError("Cannot read properties of undefined (reading 'x')");
  }),
};

for (const [name, model] of Object.entries(models)) {
  ai.defineAgent({ name, system: 'You fail.', model, store: new InMemorySessionStore() });
}

// Headless: stay alive while the box drives us over reflection.
setInterval(() => {}, 1 << 30);
