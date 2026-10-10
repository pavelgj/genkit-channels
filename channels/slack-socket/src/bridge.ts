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
 * Pure helpers for the Slack channel: which events start a turn, session keys,
 * mention stripping, length limits, and per-conversation serialization. No
 * Slack SDK or network here, so it's easy to unit test.
 */

import { createHash } from 'node:crypto';

/** Slack's limit for `markdown_text` in a single call. */
export const MAX_MARKDOWN_LEN = 12_000;

/** Namespace for deriving session ids (must be UUIDs) from session keys. */
export const SESSION_NAMESPACE = '6ba7b814-9dad-11d1-80b4-00c04fd430c8';

/** The fields of a Slack `app_mention` / `message` event we look at. */
export interface IncomingEvent {
  channel: string;
  /** `im` for DMs; `channel` / `group` / `mpim` otherwise. Absent on app_mention. */
  channelType?: string;
  user?: string;
  botId?: string;
  subtype?: string;
  text?: string;
  ts: string;
  threadTs?: string;
}

/** A turn to run: where to reply (always a thread) and the user's text. */
export interface Trigger {
  /** Thread the reply goes to, which is also the conversation. */
  threadTs: string;
  text: string;
}

/**
 * Deterministic v5 UUID for `name`. The same Slack thread always maps to the
 * same session id, so conversations survive restarts with no bookkeeping.
 */
export function uuidv5(name: string, namespace = SESSION_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1')
    .update(ns)
    .update(Buffer.from(name, 'utf8'))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/** One conversation per Slack thread (DM threads included). */
export function sessionKey(team: string, channel: string, threadTs: string): string {
  return `slack:${team}:${channel}:${threadTs}`;
}

/** Removes `<@BOT>` mentions (with or without a `|label`) and trims. */
export function stripMention(text: string | undefined, botUserId?: string): string {
  const s = text ?? '';
  if (!botUserId) return s.trim();
  return s.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g'), '').trim();
}

export function mentions(text: string | undefined, botUserId?: string): boolean {
  return !!botUserId && (text ?? '').includes(`<@${botUserId}`);
}

/** Truncates to `max`, appending an ellipsis when cut. */
export function truncate(text: string, max = MAX_MARKDOWN_LEN): string {
  return text.length > max ? text.slice(0, max - 1) + '\u2026' : text;
}

/** True for messages from bots (including ourselves) and non-plain subtypes. */
function ignorable(ev: IncomingEvent, botUserId?: string): boolean {
  return (
    !!ev.subtype || !!ev.botId || !ev.user || ev.user === botUserId
  );
}

/** An `app_mention` (channels only) always starts a turn, in a thread. */
export function mentionTrigger(
  ev: IncomingEvent,
  botUserId?: string
): Trigger | undefined {
  if (ignorable(ev, botUserId)) return undefined;
  const text = stripMention(ev.text, botUserId);
  if (!text) return undefined;
  return { threadTs: ev.threadTs ?? ev.ts, text };
}

/**
 * A plain `message` starts a turn when it's a DM, or (with `followThreads`) a
 * reply in a thread the bot already answered in. Channel messages that
 * mention the bot are left to `app_mention`, which Slack sends as well.
 */
export function messageTrigger(
  ev: IncomingEvent,
  opts: {
    botUserId?: string;
    followThreads: boolean;
    /** Whether the bot has replied in thread `threadTs` of this channel. */
    isFollowed(threadTs: string): boolean;
  }
): Trigger | undefined {
  if (ignorable(ev, opts.botUserId)) return undefined;
  const text = stripMention(ev.text, opts.botUserId);
  if (!text) return undefined;
  if (ev.channelType === 'im') {
    return { threadTs: ev.threadTs ?? ev.ts, text };
  }
  if (mentions(ev.text, opts.botUserId)) return undefined;
  if (opts.followThreads && ev.threadTs && opts.isFollowed(ev.threadTs)) {
    return { threadTs: ev.threadTs, text };
  }
  return undefined;
}

/**
 * Runs tasks one at a time per key. Two quick messages in one thread would
 * otherwise race on the same session; different threads still run in
 * parallel.
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
