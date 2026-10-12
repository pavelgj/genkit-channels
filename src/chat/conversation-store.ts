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
 * Storage for chat conversations: per conversation, the messages waiting for
 * a turn, the state the last turn saved, and whether a turn is running.
 * Implement {@link ConversationStore} to make conversations survive restarts
 * and work across instances; check an implementation with
 * `conversationStoreContract` from `genkit-channels/chat/testing`.
 *
 * Experimental: the interface may change once the first persistent store
 * (Firestore) is built against it.
 */

/** One platform event, as posted to a conversation. */
export interface ConversationMessage<M> {
  /**
   * The platform's id for the event. Posting an id the conversation has
   * already seen is a no-op, so platform redeliveries don't run twice.
   */
  id: string;
  payload: M;
}

/** A message as handed to a turn. */
export interface ConversationDelivery<M> extends ConversationMessage<M> {
  /**
   * 1 the first time. Higher when an earlier turn took the message and never
   * completed (its process died, or it lost the conversation mid-turn).
   */
  attempt: number;
}

/**
 * A running turn: the right to handle one conversation's messages until it
 * completes or expires. At most one turn per conversation is current.
 */
export interface Turn<M, S> {
  key: string;
  /** Proves the turn is still current; stores check it on every write. */
  token: string;
  /** The messages this turn handles, oldest first. */
  messages: ConversationDelivery<M>[];
  /** What the previous turn saved; undefined for a new conversation. */
  state?: S;
  /**
   * How long the turn stays current without a heartbeat; after that the next
   * post may start a new one. The loop sends heartbeats well within it.
   * Undefined: never expires (a single-process store).
   */
  expiresInMs?: number;
}

/** Thrown when a turn's token is no longer current (another took over). */
export class TurnLostError extends Error {
  constructor(readonly key: string) {
    super(`lost the turn for ${key}; another drainer took over`);
    this.name = 'TurnLostError';
  }
}

export interface TakeOptions {
  /** Most messages handed to one turn. */
  maxBatch: number;
}

/**
 * Every operation must be atomic per conversation: one transaction, so two
 * instances posting to the same conversation agree on who runs the turn.
 *
 * Size: state can grow without bound (a client-managed agent's state is its
 * whole history), so don't keep it in the same size-limited record as the
 * messages; a Firestore store, say, puts the state in its own document and
 * writes both in one transaction. The contract tests save a 2 MB state.
 */
export interface ConversationStore<M, S> {
  /**
   * Adds the message (a repeated id is a no-op). If no turn is running, or
   * the running one expired, starts a turn with the pending messages and
   * returns it: the caller must run it.
   */
  post(
    key: string,
    msg: ConversationMessage<M>,
    opts: TakeOptions
  ): Promise<Turn<M, S> | undefined>;
  /**
   * Ends a turn in one write: removes the handled messages, saves `state`
   * (when given), and either starts the next turn with what arrived
   * meanwhile (returned) or marks the conversation idle. Rejects with
   * {@link TurnLostError} if the turn isn't current, and then saves nothing.
   */
  complete(
    turn: Turn<M, S>,
    result: { handled: string[]; state?: S },
    opts: TakeOptions
  ): Promise<Turn<M, S> | undefined>;
  /** Keeps a long turn from expiring. False if it's no longer current. */
  heartbeat(turn: Turn<M, S>): Promise<boolean>;
}
