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
 * `initChannel()`: the one call a channel makes to reach the user's app.
 *
 *   import { initChannel } from 'genkit-channels';
 *
 *   const channel = initChannel();
 *   const agent = channel.agent(channel.expose.agents[0]);
 *   const turn = agent.chat({ sessionId }).sendStream('hello');
 *
 * The app runs in a box (`@genkit-ai/box`): a subprocess, an OS sandbox, a
 * container, or a remote runtime, as configured in the deployment's `box`
 * block. Handles are lazy proxies. Nothing starts until the first call, and
 * depending on `route` each session (or request) may get its own box.
 *
 * Because there may be no running process, the config (not `listActions`) is
 * the source of truth for what the app exposes. `listActions()` exists but
 * may start a box just to answer.
 */

import { Box, SINGLETON_KEY, box, type BoxRunner } from '@genkit-ai/box';
import { genkit, type ActionMetadata, type Flow, type Genkit } from 'genkit';
import type { AgentAPI } from 'genkit/beta';
import { randomUUID } from 'node:crypto';
import {
  loadChannelConfigFile,
  parseChannelConfig,
  type AgentState,
  type ChannelConfig,
  type ChannelConfigInput,
} from './config';
import { buildBoxOptions, buildRunner } from './runner';

export interface InitChannelOptions {
  /**
   * The config to use instead of reading `channel.config.json` (or
   * `GENKIT_CHANNEL_CONFIG`). Handy for tests and hand-wired setups.
   */
  config?: ChannelConfigInput;
  /** Path to the config file. Ignored when `config` is given. */
  configPath?: string;
  /** Base dir for relative paths in `config`. Defaults to the cwd. */
  baseDir?: string;
  /** A custom runner. Overrides `box.runner` from the config. */
  runner?: BoxRunner;
  /**
   * Register the exposed agents and flows on the channel's own Genkit
   * instance, so they appear in the Dev UI. Defaults to on when
   * `GENKIT_ENV=dev` (e.g. under `genkit start`).
   */
  devUi?: boolean;
}

/** The channel's handle on the user's app. */
export interface Channel<Options = Record<string, unknown>> {
  /** Which agents and flows the deployment exposes. */
  readonly expose: { readonly agents: string[]; readonly flows: string[] };
  /**
   * Channel-specific options: the deployment's `with` block. Not validated
   * against `Options`; channels should treat every field as optional.
   */
  readonly options: Options;
  /**
   * A proxy for an agent in the app. No name picks the single exposed agent
   * (throws on zero or several). Sync: the box starts on the first call.
   */
  agent<State = unknown>(name?: string): AgentAPI<State>;
  /**
   * Who owns an agent's session state, from the deployment config (default
   * `server`). Server-managed agents chat by `sessionId`; client-managed ones
   * need the caller to round-trip `state`.
   */
  agentState(name: string): AgentState;
  /** A proxy for a flow in the app. Sync: the box starts on the first call. */
  flow(name: string): Flow;
  /**
   * Starts the app's box now instead of on the first call (`route: app` only;
   * other routes have no box to warm ahead of a session). Resolves when the
   * app is up.
   */
  warm(): Promise<void>;
  /**
   * The app's actions, straight from a box. May be expensive: with a
   * per-session or per-request route it starts a box just to answer. Prefer
   * `expose`.
   */
  listActions(): Promise<Record<string, ActionMetadata>>;
  /** Stops every box the channel started. */
  close(): Promise<void>;
  /** The channel's own Genkit instance (hosts the proxies). */
  readonly ai: Genkit;
  /** The underlying box, for anything this surface doesn't cover. */
  readonly box: Box;
}

/**
 * Opens the channel's handle on the user's app. Synchronous and side-effect
 * free apart from reading config: no process starts until a proxy is called
 * (or {@link Channel.warm}).
 */
export function initChannel<Options = Record<string, unknown>>(
  opts: InitChannelOptions = {}
): Channel<Options> {
  const { config, baseDir } = opts.config
    ? {
        config: parseChannelConfig(opts.config),
        baseDir: opts.baseDir ?? process.cwd(),
      }
    : loadChannelConfigFile(opts.configPath);
  return new ChannelImpl<Options>(config, baseDir, opts);
}

class ChannelImpl<Options> implements Channel<Options> {
  readonly expose: { readonly agents: string[]; readonly flows: string[] };
  readonly options: Options;
  readonly ai: Genkit;
  readonly box: Box;
  private readonly agents = new Map<string, AgentAPI<unknown>>();
  private readonly flows = new Map<string, Flow>();
  private readonly runner: BoxRunner;
  private readonly singleton: boolean;

  constructor(
    private readonly config: ChannelConfig,
    baseDir: string,
    opts: InitChannelOptions
  ) {
    this.expose = config.expose;
    // `with` is free-form user YAML; the channel declares its expected shape.
    this.options = config.options as Options;
    this.singleton = (config.box.route ?? 'app') === 'app';

    const boxOptions = buildBoxOptions(
      config.box,
      opts.runner ?? buildRunner(config.box.runner, config.box, baseDir)
    );
    this.runner = boxOptions.runner;

    // The channel's Genkit instance only hosts proxies; it needs no plugins.
    this.ai = genkit({});
    this.box = box(this.ai, { ...boxOptions, name: 'genkit-channel' });

    if (opts.devUi ?? process.env.GENKIT_ENV === 'dev') {
      this.registerForDevUi();
    }
    if (config.box.warm) {
      this.warm().catch((e: unknown) =>
        console.error(
          `[genkit-channels] failed to warm the app: ${(e as Error).message}`
        )
      );
    }
  }

  agent<State = unknown>(name?: string): AgentAPI<State> {
    const resolved = name ?? this.soleAgent();
    let proxy = this.agents.get(resolved);
    if (!proxy) {
      proxy = this.box.agent<unknown>({ name: resolved });
      this.agents.set(resolved, proxy);
    }
    // The wire is untyped; the caller declares the agent's custom state type.
    return proxy as AgentAPI<State>;
  }

  agentState(name: string): AgentState {
    return this.config.agentState[name] ?? 'server';
  }

  flow(name: string): Flow {
    let proxy = this.flows.get(name);
    if (!proxy) {
      proxy = this.box.flow({ name });
      this.flows.set(name, proxy);
    }
    return proxy;
  }

  async warm(): Promise<void> {
    if (!this.singleton) return;
    // TODO(box): FR-4. Use box.warm() instead of reaching into the runner.
    await this.runner.acquire(SINGLETON_KEY);
  }

  async listActions(): Promise<Record<string, ActionMetadata>> {
    // TODO(box): FR-5. Use a public box.listActions().
    if (this.singleton) {
      const conn = await this.runner.acquire(SINGLETON_KEY);
      return conn.listActions();
    }
    // Non-singleton routes: a throwaway box, released right after.
    const key = `list-actions-${randomUUID()}`;
    try {
      const conn = await this.runner.acquire(key);
      return await conn.listActions();
    } finally {
      await this.runner.release(key);
    }
  }

  close(): Promise<void> {
    return this.box.close();
  }

  private soleAgent(): string {
    const { agents } = this.expose;
    if (agents.length === 1) return agents[0];
    throw new Error(
      agents.length === 0
        ? 'No agent exposed. Set `expose.agent` on the deployment in ' +
            'channels.yaml.'
        : `Several agents exposed (${agents.join(', ')}); pass a name to ` +
            `channel.agent().`
    );
  }

  /**
   * Registered proxies show up in the Dev UI. They are separate from the
   * handles `agent()` returns because registration needs `stateManagement`
   * up front.
   */
  private registerForDevUi(): void {
    // TODO(box): FR-6. Register boxed agents without declaring capabilities.
    for (const name of this.expose.agents) {
      this.box.defineAgent({ name, stateManagement: this.agentState(name) });
    }
    for (const name of this.expose.flows) {
      this.box.defineFlow({ name });
    }
  }
}
