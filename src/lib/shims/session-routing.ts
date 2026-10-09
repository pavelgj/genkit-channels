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

// TODO(box): FR-3. Drop once unregistered `box.agent()` proxies track
// sessions the way `defineAgent` does.

import {
  sessionIdOf,
  type BoxConnection,
  type BoxRunner,
  type RouteFn,
  type RunActionRequest,
  type RunOptions,
} from '@genkit-ai/box';
import { randomUUID } from 'node:crypto';

/** Caps memory use: the oldest mappings are evicted first. */
const MAX_ENTRIES = 10_000;

/** Routing key for calls that belong to no session (flows). */
const SHARED_KEY = '__shared__';

function isAgentCall(req: RunActionRequest): boolean {
  return /^\/agent(-snapshot|-abort)?\//.test(req.key);
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v: unknown = Reflect.get(value, key);
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The `snapshotId` a call resumes, reads, or aborts, if any. */
function snapshotIdOf(req: RunActionRequest): string | undefined {
  if (req.key.startsWith('/agent/')) return stringField(req.init, 'snapshotId');
  if (
    req.key.startsWith('/agent-snapshot/') ||
    req.key.startsWith('/agent-abort/')
  ) {
    return stringField(req.input, 'snapshotId');
  }
  return undefined;
}

/**
 * One box per agent session.
 *
 * `sessionIdOf` alone isn't enough: after its first turn, `AgentChat` resumes
 * with `{ snapshotId }` only, and snapshot reads and aborts carry only a
 * `snapshotId` too. Those calls would route to a fresh box. So we watch turn
 * outputs and remember which routing key each `snapshotId` and `sessionId`
 * came from.
 *
 * A first turn with no session id gets a random key. The box mints the
 * session, and later calls route back via the recorded ids.
 */
export class SessionRouting {
  private readonly keys = new Map<string, string>();

  readonly route: RouteFn = (req) => {
    // Flows (and other non-agent calls) have no session. Rather than a fresh
    // box per call, they share one box.
    if (!isAgentCall(req)) return SHARED_KEY;
    const sessionId = sessionIdOf(req);
    if (sessionId) return this.lookup(`s:${sessionId}`) ?? sessionId;
    const snapshotId = snapshotIdOf(req);
    return (snapshotId && this.lookup(`p:${snapshotId}`)) || randomUUID();
  };

  /** Wraps a runner so its connections record agent turn outputs. */
  wrap(inner: BoxRunner): BoxRunner {
    return {
      name: inner.name,
      attach: (box) => inner.attach?.(box),
      acquire: async (key, signal) =>
        this.track(await inner.acquire(key, signal), key),
      release: (key) => inner.release(key),
      close: () => inner.close(),
    };
  }

  private track(conn: BoxConnection, key: string): BoxConnection {
    return {
      listActions: () => conn.listActions(),
      runAction: async <O = unknown>(req: RunActionRequest, opts?: RunOptions) => {
        const res = await conn.runAction<O>(req, opts);
        if (req.key.startsWith('/agent/')) {
          const snapshotId = stringField(res.result, 'snapshotId');
          const sessionId = stringField(res.result, 'sessionId');
          if (snapshotId) this.remember(`p:${snapshotId}`, key);
          if (sessionId) this.remember(`s:${sessionId}`, key);
        }
        return res;
      },
    };
  }

  private lookup(id: string): string | undefined {
    return this.keys.get(id);
  }

  private remember(id: string, key: string): void {
    this.keys.delete(id);
    this.keys.set(id, key);
    if (this.keys.size > MAX_ENTRIES) {
      const oldest = this.keys.keys().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
  }
}
