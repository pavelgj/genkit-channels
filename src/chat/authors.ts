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

import type { ActionContext } from 'genkit';
import { isAuthError } from '../lib/errors';

export interface AllowedBatch<M> {
  /** Messages from authors the context provider let through, in order. */
  messages: M[];
  /** Context of the last allowed author: the one the turn runs as. */
  context?: ActionContext;
  /** Authors the provider refused (each once), with the error. */
  refused: Array<{ author: string; error: unknown }>;
}

/**
 * Runs the context check once per distinct author in a batch and keeps only
 * the messages of authors it allows.
 *
 * Coalescing can put several people's messages into one turn, which then
 * runs as one caller. Without this, a refused user's text would reach the
 * agent running with someone else's permissions. Errors other than a refusal
 * (the app is down, say) are thrown: they say nothing about the author.
 */
export async function filterAllowed<M>(
  batch: M[],
  authorOf: (message: M) => string,
  check: (message: M) => Promise<ActionContext>
): Promise<AllowedBatch<M>> {
  // The last message per author decides that author, so the context comes
  // from the author's latest message.
  const lastByAuthor = new Map<string, M>();
  for (const m of batch) lastByAuthor.set(authorOf(m), m);

  const allowed = new Map<string, ActionContext>();
  const refused: AllowedBatch<M>['refused'] = [];
  for (const [author, m] of lastByAuthor) {
    try {
      allowed.set(author, await check(m));
    } catch (e) {
      if (!isAuthError(e)) throw e;
      refused.push({ author, error: e });
    }
  }
  const messages = batch.filter((m) => allowed.has(authorOf(m)));
  const last = messages[messages.length - 1];
  return {
    messages,
    context: last === undefined ? undefined : allowed.get(authorOf(last)),
    refused,
  };
}
