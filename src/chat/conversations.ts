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
 * Chat conversations: messages are posted as platform events arrive, and the
 * handler runs one turn at a time per conversation, in order, with the state
 * the previous turn saved. Different conversations run in parallel. Where
 * messages and state live is a {@link ConversationStore}; this is the loop
 * that drives turns, the same for every store.
 */

import {
  TurnLostError,
  type ConversationDelivery,
  type ConversationMessage,
  type ConversationStore,
  type Turn,
} from './conversation-store';
import type { JsonData } from './json';
import { memoryConversationStore } from './memory-conversations';

/** What a turn handler gets. */
export interface TurnInput<M, S> {
  key: string;
  /** Oldest first; one message unless coalescing. */
  messages: ConversationDelivery<M>[];
  /** What the previous turn saved; undefined for a new conversation. */
  state?: S;
  /**
   * Aborted when another drainer took the conversation over (this one
   * stalled past its turn's expiry), or when `close()` ran out of time. Pass
   * it to the agent call, so the reply stops instead of being given twice.
   */
  signal: AbortSignal;
}

/**
 * Runs one turn. Return `{ state }` to save new state; it is saved together
 * with marking the messages handled, so a crash can't leave one without the
 * other. Return nothing to keep the previous state.
 */
export type TurnHandler<M, S> = (
  turn: TurnInput<M, S>
) => Promise<{ state: S } | void>;

export interface ConversationsOptions<M, S> {
  /**
   * true: a turn gets what's pending (up to `maxBatch`), so messages sent
   * during a turn go into the next turn together. false: one message per
   * turn, in order.
   */
  coalesce: boolean;
  handler: TurnHandler<M, S>;
  /** Default: {@link memoryConversationStore}, one process. */
  store?: ConversationStore<M, S>;
  /** Most messages in one coalesced turn; the rest wait for the next. Default 20. */
  maxBatch?: number;
  /**
   * A message handed to this many turns that never completed (each time its
   * process died mid-turn) is dropped instead of tried again, and reported to
   * `onDropped`. Only a persistent store redelivers. Default 3.
   */
  maxAttempts?: number;
  onDropped?: (key: string, msg: ConversationDelivery<M>) => void;
  /**
   * A handler that throws doesn't stall its conversation: the error is
   * reported here, the messages count as handled (the handler should have
   * told the user), and the next turn runs. Default: console.error.
   */
  onError?: (key: string, error: unknown) => void;
}

export interface Conversations<M> {
  /** Adds a message; returns once it's stored (the turn runs in the background). */
  post(key: string, msg: ConversationMessage<M>): Promise<void>;
  /** Resolves once no turn is running or about to start in this process. */
  idle(): Promise<void>;
  /**
   * For shutdown: refuses new posts and starts no new turns, waits for
   * running turns up to `timeoutMs` (default 10s), then aborts the rest.
   * What's left stays in the store for the next drainer.
   */
  close(opts?: { timeoutMs?: number }): Promise<void>;
}

/**
 * Messages and state must be JSON data ({@link JsonData}), even with the
 * memory store, so moving to a persistent store never finds a live object (a
 * socket, a platform SDK message) in it.
 */
export function createConversations<M extends JsonData<M>, S extends JsonData<S>>(
  opts: ConversationsOptions<M, S>
): Conversations<M> {
  const store = opts.store ?? memoryConversationStore<M, S>();
  const take = { maxBatch: opts.coalesce ? (opts.maxBatch ?? 20) : 1 };
  const maxAttempts = opts.maxAttempts ?? 3;
  const onError =
    opts.onError ??
    ((key: string, e: unknown) =>
      console.error(`[genkit-channels] turn for ${key} failed:`, e));
  const onDropped =
    opts.onDropped ??
    ((key: string, m: ConversationDelivery<M>) =>
      console.error(
        `[genkit-channels] dropped message ${m.id} in ${key}: ` +
          `${m.attempt - 1} earlier turns never finished`
      ));

  // Work in this process: turn chains being driven, and posts still waiting
  // on the store (a post that is about to start a turn counts as busy).
  const running = new Set<{ done: Promise<void>; abort: AbortController }>();
  const posting = new Set<Promise<void>>();
  let closed = false;

  /** Runs `first`, then each next turn the store hands back. */
  async function drive(first: Turn<M, S>, abort: AbortController): Promise<void> {
    let turn: Turn<M, S> | undefined = first;
    // After close(), the turn in progress finishes but no new one starts. The
    // store already counts that next turn as running; with a persistent store
    // it expires and the next post takes it over.
    while (turn && !closed) {
      const result = await runOne(turn, abort);
      if (abort.signal.aborted) return; // left for whoever takes over
      turn = await store.complete(turn, result, take);
    }
  }

  async function runOne(
    turn: Turn<M, S>,
    abort: AbortController
  ): Promise<{ handled: string[]; state?: S }> {
    const handled = turn.messages.map((m) => m.id);
    const live = turn.messages.filter((m) => {
      if (m.attempt <= maxAttempts) return true;
      onDropped(turn.key, m);
      return false;
    });
    if (live.length === 0) return { handled };
    const beat = heartbeats(turn, abort);
    try {
      const out = await opts.handler({
        key: turn.key,
        messages: live,
        state: turn.state,
        signal: abort.signal,
      });
      return out ? { handled, state: out.state } : { handled };
    } catch (e) {
      if (!abort.signal.aborted) onError(turn.key, e);
      return { handled };
    } finally {
      clearInterval(beat);
    }
  }

  /**
   * Keeps an expiring turn alive: the store says how long a turn lasts, and
   * this beats at a third of that, so one slow heartbeat doesn't lose it.
   */
  function heartbeats(
    turn: Turn<M, S>,
    abort: AbortController
  ): NodeJS.Timeout | undefined {
    if (turn.expiresInMs === undefined) return undefined;
    return setInterval(() => {
      store.heartbeat(turn).then(
        (current) => {
          if (!current) abort.abort(new TurnLostError(turn.key));
        },
        (e: unknown) => onError(turn.key, e)
      );
    }, Math.max(1, Math.floor(turn.expiresInMs / 3)));
  }

  function start(turn: Turn<M, S>): void {
    const abort = new AbortController();
    const entry = { done: Promise.resolve(), abort };
    entry.done = drive(turn, abort)
      .catch((e: unknown) => {
        // Losing the turn between steps just means someone else drives it.
        if (!(e instanceof TurnLostError)) onError(turn.key, e);
      })
      .finally(() => running.delete(entry));
    running.add(entry);
  }

  async function post(key: string, msg: ConversationMessage<M>): Promise<void> {
    if (closed) throw new Error('conversations are closed');
    const turn = await store.post(key, msg, take);
    if (turn) start(turn);
  }

  async function idle(): Promise<void> {
    while (posting.size > 0 || running.size > 0) {
      await Promise.all([...posting, ...[...running].map((r) => r.done)]);
    }
  }

  return {
    post(key, msg) {
      const p = post(key, msg).finally(() => posting.delete(p));
      posting.add(p);
      return p;
    },
    idle,
    async close({ timeoutMs = 10_000 } = {}) {
      closed = true;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      });
      const late = await Promise.race([idle().then(() => false), timedOut]);
      clearTimeout(timer);
      if (!late) return;
      const reason = new Error('closed before the turn finished');
      for (const r of running) r.abort.abort(reason);
      await idle();
    },
  };
}
