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

// TODO(box): FR-2. Replace with box's `remoteRunner()`.

import {
  ReflectionClientV1,
  type BoxConnection,
  type BoxRunner,
} from '@genkit-ai/box';

export interface RemoteRunnerOptions {
  /** Base URL of a runtime serving v1 reflection, e.g. `http://localhost:3100`. */
  url: string;
  /** The runtime's `GENKIT_REFLECTION_SECRET_TOKEN`. */
  secret?: string;
  /** How long to wait for the runtime to answer its health check. */
  readyTimeoutMs?: number;
}

/**
 * A {@link BoxRunner} over a runtime someone else started (a sidecar
 * container, a remote service). There is no lifecycle to own: every routing
 * key maps to the same runtime, and release/close are no-ops.
 */
export class RemoteRunner implements BoxRunner {
  readonly name = 'remote';
  private readonly client: ReflectionClientV1;
  private ready?: Promise<void>;

  constructor(private readonly options: RemoteRunnerOptions) {
    this.client = new ReflectionClientV1(options.url.replace(/\/+$/, ''), {
      secret: options.secret,
    });
  }

  async acquire(_key: string, signal?: AbortSignal): Promise<BoxConnection> {
    // Wait once; a failed wait is retried on the next acquire.
    this.ready ??= this.client
      .waitForReady(this.options.readyTimeoutMs ?? 30_000, signal)
      .catch((e: unknown) => {
        this.ready = undefined;
        throw e;
      });
    await this.ready;
    return this.client;
  }

  async release(): Promise<void> {}

  async close(): Promise<void> {}
}
