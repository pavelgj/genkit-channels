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
  /**
   * A bare @mention in a thread: `text` is empty and the input is whatever
   * users posted since the bot's last reply (see `missedMessages`).
   */
  catchUp?: boolean;
}

/** A thread message (from `conversations.replies`), reduced to what we use. */
export interface ThreadMessage {
  ts: string;
  user?: string;
  botId?: string;
  subtype?: string;
  text?: string;
}

/** Who "we" are in Slack. Bot-token messages carry both ids. */
export interface BotIdentity {
  userId?: string;
  botId?: string;
}

export function isOwnMessage(m: ThreadMessage, bot: BotIdentity): boolean {
  return (
    (!!bot.userId && m.user === bot.userId) ||
    (!!bot.botId && m.botId === bot.botId)
  );
}

/**
 * What users posted in a thread after the bot's last reply, as one turn's
 * input (oldest first, one message per line). If the bot never replied, that's
 * the whole thread. `exceptTs` drops the triggering bare mention.
 */
export function missedMessages(
  thread: ThreadMessage[],
  bot: BotIdentity,
  exceptTs?: string
): string {
  let start = 0;
  thread.forEach((m, i) => {
    if (isOwnMessage(m, bot)) start = i + 1;
  });
  return thread
    .slice(start)
    .filter(
      (m) =>
        m.ts !== exceptTs &&
        !!m.user &&
        !m.botId &&
        // "Also send to channel" replies are still user messages.
        (!m.subtype || m.subtype === 'thread_broadcast')
    )
    .map((m) => stripMention(m.text, bot.userId))
    .filter(Boolean)
    .join('\n');
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

/**
 * An `app_mention` (channels only) always starts a turn, in a thread. A bare
 * mention inside a thread ("@bot", "you there?") catches up on what the bot
 * missed; a bare mention at the top level has nothing to answer.
 */
export function mentionTrigger(
  ev: IncomingEvent,
  botUserId?: string
): Trigger | undefined {
  if (ignorable(ev, botUserId)) return undefined;
  const text = stripMention(ev.text, botUserId);
  if (text) return { threadTs: ev.threadTs ?? ev.ts, text };
  return ev.threadTs ? { threadTs: ev.threadTs, text: '', catchUp: true } : undefined;
}

/**
 * A plain `message` starts a turn when it's a DM, or (with `followThreads`) a
 * reply in a thread the bot already answered in. Channel messages that
 * mention the bot are left to `app_mention`, which Slack sends as well.
 *
 * `isFollowed` may hit the Slack API (see `ThreadTracker`), so it's only
 * consulted for un-mentioned channel thread replies, after the cheap checks.
 */
export async function messageTrigger(
  ev: IncomingEvent,
  opts: {
    botUserId?: string;
    followThreads: boolean;
    /** Whether the bot has replied in thread `threadTs` of this channel. */
    isFollowed(threadTs: string): boolean | Promise<boolean>;
  }
): Promise<Trigger | undefined> {
  if (ignorable(ev, opts.botUserId)) return undefined;
  const text = stripMention(ev.text, opts.botUserId);
  if (!text) return undefined;
  if (ev.channelType === 'im') {
    return { threadTs: ev.threadTs ?? ev.ts, text };
  }
  if (mentions(ev.text, opts.botUserId)) return undefined;
  if (opts.followThreads && ev.threadTs && (await opts.isFollowed(ev.threadTs))) {
    return { threadTs: ev.threadTs, text };
  }
  return undefined;
}

/** Reads a thread, oldest first; `undefined` when Slack refused or failed. */
export type FetchThread = (
  channel: string,
  threadTs: string
) => Promise<ThreadMessage[] | undefined>;

/**
 * Which threads the bot takes part in, for `followThreads`. Answers from
 * memory when it can; otherwise reads the thread from Slack once and
 * remembers the answer, so it survives restarts and moving between instances
 * at the cost of at most one API call per unknown thread per process.
 *
 * A failed read counts as "not followed" and is remembered too: retrying on
 * every message would only make a rate limit worse. A later mention fixes it.
 */
export class ThreadTracker {
  private known = new Map<string, boolean>();
  private pending = new Map<string, Promise<boolean>>();
  private readonly maxEntries: number;

  constructor(
    private readonly opts: {
      fetchThread: FetchThread;
      bot: () => BotIdentity;
      /** Oldest entries are forgotten past this. Default 10,000. */
      maxEntries?: number;
    }
  ) {
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  follow(channel: string, threadTs: string): void {
    this.remember(`${channel}:${threadTs}`, true);
  }

  isFollowed(channel: string, threadTs: string): boolean | Promise<boolean> {
    const key = `${channel}:${threadTs}`;
    const hit = this.known.get(key);
    if (hit !== undefined) return hit;
    // Several quick replies in one unknown thread share a single lookup.
    let lookup = this.pending.get(key);
    if (!lookup) {
      lookup = this.lookup(channel, threadTs, key);
      this.pending.set(key, lookup);
    }
    return lookup;
  }

  private async lookup(channel: string, threadTs: string, key: string): Promise<boolean> {
    try {
      const thread = await this.opts.fetchThread(channel, threadTs);
      const bot = this.opts.bot();
      const followed = !!thread?.some((m) => isOwnMessage(m, bot));
      // A follow() while we were reading wins over what we read.
      if (!this.known.has(key)) this.remember(key, followed);
      return this.known.get(key) ?? followed;
    } finally {
      this.pending.delete(key);
    }
  }

  private remember(key: string, followed: boolean): void {
    this.known.delete(key); // re-insert to refresh its position
    this.known.set(key, followed);
    if (this.known.size > this.maxEntries) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
  }
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
