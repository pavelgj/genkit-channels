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
 * Pure, platform-agnostic helpers for the Discord channel. Keeping these free
 * of `discord.js` and network calls makes them straightforward to unit test.
 *
 * Covers: session-key derivation (stable across restarts), bot-mention
 * stripping, Discord's 2000-char message limit, and formatting a batch of
 * gathered messages (with sender attribution) into a single agent turn input.
 */

import { createHash } from 'node:crypto';

/** Discord's hard limit on a single message's content length. */
export const MAX_DISCORD_LEN = 2000;

/**
 * Default namespace UUID for deriving session ids. Session ids must be UUIDs,
 * so we hash a human-readable session key (e.g. `discord:channel:1:thread:2`)
 * into a stable v5 UUID. The same key always maps to the same id, so sessions
 * survive restarts with no bookkeeping.
 */
export const DEFAULT_SESSION_NAMESPACE =
  '6ba7b814-9dad-11d1-80b4-00c04fd430c8';

/** A normalized message used to derive a stable session key. */
export interface SessionMessage {
  isDM: boolean;
  userId: string;
  channelId: string;
  threadId?: string;
  id: string;
}

/** A gathered message to format into a single agent-turn input. */
export interface GatheredMessage {
  userName: string;
  text: string;
}

function parseUuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || /[^0-9a-f]/i.test(hex)) {
    throw new Error(`Invalid namespace UUID: "${uuid}"`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Computes a deterministic RFC 4122 v5 (SHA-1) UUID from `name` within
 * `namespace`.
 */
export function uuidv5(
  name: string,
  namespace: string = DEFAULT_SESSION_NAMESPACE
): string {
  const ns = parseUuidToBytes(namespace);
  const hash = createHash('sha1')
    .update(ns)
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = hash.subarray(0, 16);
  // Set version (5) and variant (RFC 4122) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * Derives a stable session key for a normalized message. DMs are per-user;
 * channel messages are per-thread (falling back to the triggering message id so
 * a brand-new top-level message starts a fresh session).
 */
export function deriveSessionKey(msg: SessionMessage): string {
  if (msg.isDM) {
    return `discord:user:${msg.userId}`;
  }
  const thread = msg.threadId ?? msg.id;
  return `discord:channel:${msg.channelId}:thread:${thread}`;
}

/**
 * Removes mentions of the bot (`<@id>` / `<@!id>`) from a message's raw content
 * and trims the result. When `botId` is unknown, returns the trimmed content.
 */
export function stripMention(
  content: string | undefined | null,
  botId?: string
): string {
  if (!botId) return (content ?? '').trim();
  return (content ?? '')
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .trim();
}

/**
 * Truncates text to Discord's message limit, appending an ellipsis when cut.
 */
export function truncate(
  text: string | undefined | null,
  max: number = MAX_DISCORD_LEN
): string {
  const s = text ?? '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Formats a batch of gathered messages into a single agent-turn input. Each
 * message is attributed to its sender so a shared channel session reads as a
 * multi-party conversation. Empty messages are skipped; a single message with
 * `includeSenderName: false` is returned verbatim.
 *
 * @param messages ordered oldest-first
 */
export function formatGatheredMessages(
  messages: GatheredMessage[],
  opts: { includeSenderName?: boolean } = {}
): string {
  const includeSenderName = opts.includeSenderName ?? true;
  const parts: string[] = [];
  for (const m of messages) {
    const text = (m.text ?? '').trim();
    if (!text) continue;
    parts.push(includeSenderName ? `[${m.userName}]: ${text}` : text);
  }
  return parts.join('\n\n');
}
