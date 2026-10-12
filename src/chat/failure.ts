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
 * Turning a failed turn into something a chat user can act on.
 *
 * What survives the trip from the app (checked with both box runners, see
 * test/failures.mjs):
 *  - Agent turns fail with `AgentError`, carrying the app's status name:
 *    RESOURCE_EXHAUSTED for quota, FAILED_PRECONDITION for a missing key,
 *    INTERNAL for bugs and mid-stream failures.
 *  - A safety block is also FAILED_PRECONDITION; only the attached response's
 *    `finishReason: 'blocked'` tells it apart.
 *  - An unknown agent and an app that never started both come back as
 *    UNKNOWN; the box's message is the only signal.
 */

import type { StatusName } from 'genkit';
import { errorStatus } from '../lib/errors';

export type FailureKind =
  | 'refused'
  | 'rate-limited'
  | 'blocked'
  | 'config'
  | 'unavailable'
  | 'unexpected';

export interface Failure {
  kind: FailureKind;
  status?: StatusName;
  /** Safe to show in the chat. */
  userMessage: string;
  /** For the channel's log: kind, status and the underlying message. */
  logMessage: string;
}

export const DEFAULT_FAILURE_MESSAGES: Record<FailureKind, string> = {
  refused: "Sorry, you aren't allowed to use this bot.",
  'rate-limited': "I'm getting too many requests right now. Please try again in a minute.",
  blocked: "Sorry, I can't help with that.",
  config: "I'm not set up correctly. The bot's owner can find details in its logs.",
  unavailable: "I couldn't start just now. Please try again in a moment.",
  unexpected: 'Sorry, something went wrong. Please try again.',
};

// Box messages for an app that isn't reachable, and for an unknown action.
const UNAVAILABLE_MESSAGE =
  /exited before it was ready|Timed out waiting for box|ECONNREFUSED|fetch failed/;
// Exec runner: "action /agent/x not found"; remote: "Box runAction failed:
// 404 action /agent/x not found".
const NOT_FOUND_MESSAGE = /\baction \/\S+ not found/;

export function describeFailure(
  e: unknown,
  messages: Partial<Record<FailureKind, string>> = {}
): Failure {
  const status = errorStatus(e);
  const message = e instanceof Error ? e.message : String(e);
  const kind = classify(e, status, message);
  return {
    kind,
    status,
    userMessage: messages[kind] ?? DEFAULT_FAILURE_MESSAGES[kind],
    logMessage: `${kind}${status ? ` (${status})` : ''}: ${message}`,
  };
}

function classify(e: unknown, status: StatusName | undefined, message: string): FailureKind {
  switch (status) {
    case 'UNAUTHENTICATED':
    case 'PERMISSION_DENIED':
      return 'refused';
    case 'RESOURCE_EXHAUSTED':
      return 'rate-limited';
    case 'UNAVAILABLE':
    case 'DEADLINE_EXCEEDED':
      return 'unavailable';
    case 'FAILED_PRECONDITION':
      return finishReason(e) === 'blocked' ? 'blocked' : 'config';
    case 'NOT_FOUND':
      return 'config';
  }
  if (NOT_FOUND_MESSAGE.test(message)) return 'config';
  if (UNAVAILABLE_MESSAGE.test(message)) return 'unavailable';
  return 'unexpected';
}

/** The model's finish reason, when the error carries the model response. */
function finishReason(e: unknown): unknown {
  return (
    path(e, 'details', 'response', 'finishReason') ??
    path(e, 'response', 'raw', 'error', 'details', 'response', 'finishReason')
  );
}

function path(value: unknown, ...keys: string[]): unknown {
  let at = value;
  for (const key of keys) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = Reflect.get(at, key);
  }
  return at;
}
