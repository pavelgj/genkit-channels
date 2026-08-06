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
 * Drives a Genkit agent over reflection v2.
 *
 * A channel that talks to *agents* (Discord, Slack, ...) wants the ergonomic
 * `AgentAPI` surface (`chat().sendStream()`, running state, interrupts, typed
 * failures) rather than raw `runAction` calls. Genkit already ships that
 * surface as {@link createAgentAPI}, parameterized over an
 * {@link AgentTransport}. This module implements that transport on top of an
 * {@link AppProcess}: an agent turn becomes a streaming `runAction`, and the
 * `getSnapshot` / `abort` companion actions become plain `runAction` calls to
 * the agent's `/agent-snapshot/*` and `/agent-abort/*` keys.
 *
 * The result: a channel gets the exact same `AgentAPI` it would get from
 * `remoteAgent(...)`, but the calls ride the in-process reflection link instead
 * of HTTP.
 *
 * In practice channels reach this surface through {@link AppProcess.getAgent}
 * (which discovers the agent and builds the client for you); the free functions
 * below are the lower-level building blocks it uses.
 *
 *   const agent = await app.getAgent('weatherAgent');
 *   const chat = agent.chat({ sessionId });
 *   const turn = chat.sendStream('hello');
 *   for await (const chunk of turn.stream) process.stdout.write(chunk.text);
 */

import {
  createAgentAPI,
  type AgentAPI,
  type AgentChat,
  type AgentResponse,
  type AgentTurn,
  type AgentTransport,
  type SnapshotLookup,
} from '@genkit-ai/ai/agent-core';
import type {
  AgentInit,
  AgentInput,
  AgentOutput,
  AgentStreamChunk,
} from '@genkit-ai/ai';
import type { SessionSnapshot } from '@genkit-ai/ai/session';
import type { AppProcess } from './app-process';

// Re-export the ergonomic agent-client surface so channels can annotate against
// it directly (e.g. `let agent: AgentAPI`) without reaching into `@genkit-ai/ai`.
export type { AgentAPI, AgentChat, AgentResponse, AgentTurn };


/** Who owns an agent's session state, as reported by the runtime. */
export type AgentStateManagement = 'server' | 'client';

/** A discovered agent action plus the capability metadata a channel needs. */
export interface DiscoveredAgent {
  /** Full action key, e.g. `/agent/weatherAgent`. */
  key: string;
  /** Short agent name, e.g. `weatherAgent`. */
  name: string;
  /**
   * `server` when the agent has a session store (history persists server-side,
   * addressed by `sessionId`); `client` when the caller must round-trip the
   * session state blob itself. `undefined` when the runtime did not report it
   * (the agent client then auto-detects from the first turn's output shape).
   */
  stateManagement?: AgentStateManagement;
  /** Whether the agent's invocations can be aborted (needs a capable store). */
  abortable?: boolean;
}

/** Options for {@link createAgentApi}. */
export interface CreateAgentApiOptions {
  /** The agent action key, e.g. `/agent/weatherAgent`. */
  key: string;
  /**
   * State ownership. When omitted, the agent client infers it from the first
   * turn (each turn's output carries either a `snapshotId` or inline `state`).
   * Pass the value from {@link listAgents} to skip the inference round trip.
   */
  stateManagement?: AgentStateManagement;
}

/** The `/agent/<name>` prefix that marks an agent action. */
const AGENT_KEY_PREFIX = '/agent/';

/** Extracts the short agent name from a `/agent/<name>` key. */
function agentNameFromKey(key: string): string {
  return key.startsWith(AGENT_KEY_PREFIX)
    ? key.slice(AGENT_KEY_PREFIX.length)
    : key;
}

/**
 * Extracts the agents from a `listActions` map, with the capability metadata a
 * channel needs to drive them (`stateManagement`, `abortable`). Keeps only
 * `/agent/*` entries. This is the pure core behind {@link AppProcess.listAgents}.
 */
export function discoverAgents(
  actions: Record<string, unknown>
): DiscoveredAgent[] {
  const agents: DiscoveredAgent[] = [];
  for (const [key, meta] of Object.entries(actions)) {
    if (!key.startsWith(AGENT_KEY_PREFIX)) continue;
    const agentMeta = (meta as any)?.metadata?.agent as
      | { stateManagement?: AgentStateManagement; abortable?: boolean }
      | undefined;
    agents.push({
      key,
      name: agentNameFromKey(key),
      stateManagement: agentMeta?.stateManagement,
      abortable: agentMeta?.abortable,
    });
  }
  return agents;
}


/**
 * A minimal single-producer async queue that turns push-style stream callbacks
 * into a pull-style {@link AsyncIterable}. The producer calls {@link push} for
 * each item and {@link close} (optionally with an error) when done.
 */
class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }> = [];
  private done = false;
  private error: unknown;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  close(error?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    // Drain any parked consumers.
    while (this.waiters.length) {
      const waiter = this.waiters.shift()!;
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length) {
          return Promise.resolve({ value: this.values.shift()!, done: false });
        }
        if (this.done) {
          return this.error
            ? Promise.reject(this.error)
            : Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

/**
 * Builds an {@link AgentTransport} that runs turns and companion actions over an
 * {@link AppProcess}. The turn's streamed `AgentStreamChunk`s arrive as
 * reflection `streamChunk` notifications; the final `AgentOutput` is the
 * `runAction` result. Failed turns resolve (non-throwing) with
 * `finishReason: 'failed'`, exactly as the agent client core expects.
 */
function createReflectionAgentTransport(
  app: AppProcess,
  opts: CreateAgentApiOptions
): AgentTransport {
  const name = agentNameFromKey(opts.key);
  const snapshotKey = `/agent-snapshot/${name}`;
  const abortKey = `/agent-abort/${name}`;

  return {
    stateManagement: opts.stateManagement,

    runTurn(
      input: AgentInput,
      init: AgentInit,
      runOpts: { abortSignal: AbortSignal }
    ): {
      stream: AsyncIterable<AgentStreamChunk>;
      output: Promise<AgentOutput>;
    } {
      const queue = new AsyncQueue<AgentStreamChunk>();
      let traceId: string | undefined;

      // Client disconnect / caller abort maps to cancelAction on the runtime.
      const onAbort = () => {
        if (traceId) app.cancelAction(traceId);
      };
      if (runOpts.abortSignal.aborted) {
        onAbort();
      } else {
        runOpts.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      const output = app
        .runAction<AgentOutput>({
          key: opts.key,
          input,
          init,
          onChunk: (chunk) => queue.push(chunk as AgentStreamChunk),
          onTraceId: (tid) => {
            traceId = tid;
          },
        })
        .then((res) => {
          queue.close();
          return res.result;
        })
        .catch((err) => {
          // Surface transport-level failures into the stream too, so a consumer
          // iterating `turn.stream` sees the error instead of a silent end.
          queue.close(err);
          throw err;
        })
        .finally(() => {
          runOpts.abortSignal.removeEventListener('abort', onAbort);
        });

      return { stream: queue, output };
    },

    async getSnapshot(
      lookup: SnapshotLookup
    ): Promise<SessionSnapshot<any> | undefined> {
      const res = await app.runAction<SessionSnapshot<any> | undefined>({
        key: snapshotKey,
        input: lookup,
      });
      return res.result;
    },

    async abort(
      snapshotId: string
    ): Promise<SessionSnapshot['status'] | undefined> {
      const res = await app.runAction<{
        snapshotId: string;
        status?: SessionSnapshot['status'];
      }>({
        key: abortKey,
        input: { snapshotId },
      });
      return res.result?.status;
    },
  };
}

/**
 * Creates an {@link AgentAPI} for an agent discovered on an {@link AppProcess}.
 * The returned surface is identical to `remoteAgent(...)`, so channel code and
 * the reference chat bridge work against it unchanged.
 */
export function createAgentApi<State = unknown>(
  app: AppProcess,
  opts: CreateAgentApiOptions
): AgentAPI<State> {
  return createAgentAPI<State>(createReflectionAgentTransport(app, opts));
}
