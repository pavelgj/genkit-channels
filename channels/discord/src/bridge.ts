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
 * Covers: session keys (stable across restarts), bot-mention stripping,
 * Discord's 2000-char message limit, and turning the messages since the bot's
 * last reply (with sender attribution) into a single agent turn input.
 * Session ids, ordering and splitting come from genkit-channels/chat.
 */

/** Discord's hard limit on a single message's content length. */
export const MAX_DISCORD_LEN = 2000;

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

/** A message with its Discord id (a snowflake: later messages sort higher). */
export interface IdentifiedMessage extends GatheredMessage {
  id: string;
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

/**
 * The messages one turn should see, oldest first: the queued triggers plus
 * the channel history since the bot's last reply, without duplicates, and
 * without anything an earlier turn already answered (`answeredUpTo`, the
 * newest message id a previous turn used). History alone isn't enough: a
 * trigger that arrived before the bot posted its previous reply sits above
 * that reply in the channel.
 */
export function turnMessages(
  triggers: IdentifiedMessage[],
  history: IdentifiedMessage[],
  answeredUpTo?: string
): IdentifiedMessage[] {
  const byId = new Map<string, IdentifiedMessage>();
  for (const m of [...history, ...triggers]) byId.set(m.id, m);
  const floor = answeredUpTo === undefined ? undefined : BigInt(answeredUpTo);
  return [...byId.values()]
    .filter((m) => floor === undefined || BigInt(m.id) > floor)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}
