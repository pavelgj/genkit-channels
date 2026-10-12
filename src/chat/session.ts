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

import { createHash } from 'node:crypto';

/**
 * Namespace for session ids. Changing it would orphan every existing
 * conversation, so it stays what the Slack and Discord channels used before
 * this moved here.
 */
const SESSION_NAMESPACE = Buffer.from('6ba7b8149dad11d180b400c04fd430c8', 'hex');

/**
 * The session id (a v5 UUID) for a conversation key such as
 * `slack:T1:C1:1712.0001`. The same key always gives the same id, so a
 * conversation survives restarts with no bookkeeping.
 */
export function sessionId(key: string): string {
  const bytes = createHash('sha1')
    .update(SESSION_NAMESPACE)
    .update(key, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}
