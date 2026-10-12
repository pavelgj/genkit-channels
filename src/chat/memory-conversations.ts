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

import { randomUUID } from 'node:crypto';
import {
  TurnLostError,
  type ConversationDelivery,
  type ConversationStore,
  type TakeOptions,
  type Turn,
} from './conversation-store';

interface Record<M, S> {
  pending: ConversationDelivery<M>[];
  state?: S;
  /** Token of the running turn, if any. */
  turn?: string;
  /** Recent message ids, oldest first, for dropping redeliveries. */
  seen: string[];
}

/**
 * The in-process {@link ConversationStore}: one instance, gone on restart.
 * Turns never expire (the process running one is this one).
 *
 * Bounded: each conversation remembers its last `rememberIds` message ids
 * (default 100), and at most `maxConversations` idle conversations are kept
 * (default 10,000, least recently used dropped first, state included).
 */
export function memoryConversationStore<M, S>(
  opts: { rememberIds?: number; maxConversations?: number } = {}
): ConversationStore<M, S> {
  const rememberIds = opts.rememberIds ?? 100;
  const maxConversations = opts.maxConversations ?? 10_000;
  // Insertion order doubles as recency: touching a record moves it last.
  const records = new Map<string, Record<M, S>>();

  const touch = (key: string): Record<M, S> => {
    const rec = records.get(key) ?? { pending: [], seen: [] };
    records.delete(key);
    records.set(key, rec);
    for (const [k, r] of records) {
      if (records.size <= maxConversations) break;
      if (!r.turn && r.pending.length === 0) records.delete(k);
    }
    return rec;
  };

  const start = (key: string, rec: Record<M, S>, o: TakeOptions): Turn<M, S> => {
    rec.turn = randomUUID();
    const messages = rec.pending.slice(0, o.maxBatch);
    for (const m of messages) m.attempt++;
    return {
      key,
      token: rec.turn,
      messages: messages.map((m) => ({ ...m })),
      state: rec.state,
    };
  };

  return {
    async post(key, msg, o) {
      const rec = touch(key);
      if (rec.seen.includes(msg.id)) return undefined;
      rec.seen.push(msg.id);
      if (rec.seen.length > rememberIds) rec.seen.shift();
      rec.pending.push({ ...msg, attempt: 0 });
      return rec.turn ? undefined : start(key, rec, o);
    },
    async complete(turn, result, o) {
      const rec = records.get(turn.key);
      if (!rec || rec.turn !== turn.token) throw new TurnLostError(turn.key);
      const handled = new Set(result.handled);
      rec.pending = rec.pending.filter((m) => !handled.has(m.id));
      if ('state' in result) rec.state = result.state;
      if (rec.pending.length > 0) return start(turn.key, rec, o);
      rec.turn = undefined;
      return undefined;
    },
    async heartbeat(turn) {
      return records.get(turn.key)?.turn === turn.token;
    },
  };
}
