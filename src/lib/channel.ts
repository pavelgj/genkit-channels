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

import {
  Box,
  SHARED_KEY,
  SINGLETON_KEY,
  box,
  type BoxRunner,
} from '@genkit-ai/box';
import {
  genkit,
  type ActionContext,
  type ActionMetadata,
  type Flow,
  type Genkit,
} from 'genkit';
import type { AgentAPI } from 'genkit/beta';
import {
  CHANNEL_REQUEST_METHODS,
  contextProviderFlowName,
  type ChannelCaller,
  type ChannelRequest,
  type ChannelRequestMethod,
} from './channel-request';
import {
  loadChannelConfigFile,
  parseChannelConfig,
  type AgentState,
  type ChannelConfig,
  type ChannelConfigInput,
  type Expose,
} from './config';
import {
  contextProviderSecrets,
  runBuiltinContextProvider,
} from './context-providers';
import { buildBoxOptions, buildRunner } from './runner';

/**
 * What a channel passes to {@link Channel.context}. Loose on purpose so
 * framework objects fit as is: Node's `req.headers` (array values, any case),
 * Express's `req.method` (a string).
 */
export interface ContextRequest {
  /** Defaults to `POST`. Case-insensitive. */
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** The call's payload: an HTTP body, a chat message's text, ... */
  input?: unknown;
  /** Chat transports: who is calling, since there are no headers. */
  channel?: ChannelCaller;
}

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

/** Per-conversation options for {@link Channel.agent}. */
export interface AgentHandleOptions {
  /**
   * The conversation this handle is for. With `route: session` every call
   * through the handle (turns, snapshot reads, aborts) goes to this session's
   * box. Pass the same id to `chat({ sessionId })` for server-managed agents.
   */
  sessionId?: string;
  /** Extra action context, passed to the route and on to the agent. */
  context?: ActionContext;
}

/** The channel's handle on the user's app. */
export interface Channel<Options = Record<string, unknown>> {
  /**
   * Which agents and flows the deployment exposes, and the context provider
   * that guards them (if any).
   */
  readonly expose: Readonly<Expose>;
  /**
   * Channel-specific options: the deployment's `with` block. Not validated
   * against `Options`; channels should treat every field as optional.
   */
  readonly options: Options;
  /**
   * A proxy for an agent in the app. No name picks the single exposed agent
   * (throws on zero or several). Sync: the box starts on the first call.
   *
   * Handles are cheap. With `route: session`, make one per conversation and
   * pass its `sessionId`, so the whole conversation lands on one box:
   *
   * ```ts
   * const agent = channel.agent('concierge', { sessionId });
   * await agent.chat({ sessionId }).send('hi');
   * ```
   */
  agent<State = unknown>(
    name?: string,
    opts?: AgentHandleOptions
  ): AgentAPI<State>;
  /**
   * Who owns an agent's session state, from the deployment config (default
   * `server`). Server-managed agents chat by `sessionId`; client-managed ones
   * need the caller to round-trip `state`.
   */
  agentState(name: string): AgentState;
  /**
   * Runs the app's context provider (`expose.contextProvider`) for one
   * incoming call and returns the action context to pass on. Resolves to `{}`
   * when none is configured, so channels can always call it.
   *
   * Rejects with the provider's error when it refuses the caller; check it
   * with `isAuthError(e)` or map it with `httpStatusFor(e)` (401/403).
   *
   * ```ts
   * const context = await channel.context({ method: req.method, headers: req.headers, input: req.body });
   * const agent = channel.agent(name, { sessionId, context });
   * ```
   *
   * A built-in provider (`contextProvider: { apiKey: ... }`) runs right here
   * and never touches the app. An app-defined one runs on the shared box
   * (`route: session`) or the app's one box, so a refused caller never
   * starts a session box. Under `route: request` it costs a box start per
   * call, like everything else.
   */
  context(request: ContextRequest): Promise<ActionContext>;
  /** A proxy for a flow in the app. Sync: the box starts on the first call. */
  flow(name: string): Flow;
  /**
   * A secret the channel declared in its `channel.yaml` (`secrets:`). Reads
   * the process env, however it got there (`.env` locally, Secret Manager on
   * Cloud Run). Throws with a pointer to the config if it isn't set.
   */
  secret(name: string): string;
  /**
   * Starts the app's box now instead of on the first call. Resolves when the
   * app is up. With `route: session` this warms the shared box (the one
   * flows and session-less calls use).
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
  readonly expose: Readonly<Expose>;
  readonly options: Options;
  readonly ai: Genkit;
  readonly box: Box;
  /** Context-free agent handles, reused across calls. */
  private readonly agents = new Map<string, AgentAPI<unknown>>();
  private readonly flows = new Map<string, Flow>();
  private readonly warmKey: string | undefined;

  constructor(
    private readonly config: ChannelConfig,
    baseDir: string,
    opts: InitChannelOptions
  ) {
    // Fail at startup, not on the first message, if a declared secret is
    // missing. The CLI checks this before launching, so this mostly catches
    // hand-run channels.
    // A built-in provider's keys count too: the CLI lists them in `secrets`,
    // a hand-written config may not.
    const required = new Set([
      ...config.secrets,
      ...contextProviderSecrets(config.expose.contextProvider),
    ]);
    const missing = [...required].filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(
        `Missing secrets: ${missing.join(', ')}. Add them to .env.local for ` +
          `local runs (or set them in the environment).`
      );
    }
    this.expose = config.expose;
    // `with` is free-form user YAML; the channel declares its expected shape.
    this.options = config.options as Options;
    // Which key warm() starts: the singleton box, or sessionRoute's shared box.
    // A per-request route has nothing to warm (boxes die after each call).
    const route = config.box.route ?? 'app';
    this.warmKey =
      route === 'app' ? SINGLETON_KEY : route === 'session' ? SHARED_KEY : undefined;

    const boxOptions = buildBoxOptions(
      config.box,
      opts.runner ?? buildRunner(config.box.runner, config.box, baseDir)
    );

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

  agent<State = unknown>(
    name?: string,
    opts?: AgentHandleOptions
  ): AgentAPI<State> {
    const resolved = name ?? this.soleAgent();
    const context = opts?.sessionId
      ? { ...opts.context, sessionId: opts.sessionId }
      : opts?.context;
    // Box proxies are untyped on the wire; the caller declares the agent's
    // custom state type. An empty context (`context()` without a provider)
    // reuses the shared handle.
    if (context && Object.keys(context).length > 0) {
      return this.box.agent<State>({ name: resolved, context });
    }
    let proxy = this.agents.get(resolved);
    if (!proxy) {
      proxy = this.box.agent<unknown>({ name: resolved });
      this.agents.set(resolved, proxy);
    }
    return proxy as AgentAPI<State>;
  }

  agentState(name: string): AgentState {
    return this.config.agentState[name] ?? 'server';
  }

  async context(request: ContextRequest): Promise<ActionContext> {
    const provider = this.expose.contextProvider;
    if (provider === undefined) return {};
    // Built-ins run here, in the channel: no box hop, no app code needed.
    if (typeof provider !== 'string') {
      return runBuiltinContextProvider(provider, toChannelRequest(request));
    }
    const name = provider;
    const key = `/flow/${contextProviderFlowName(name)}`;
    // No context on this call: the route sends it to the shared/singleton
    // box, never a session's.
    let result: unknown;
    try {
      result = await this.flow(contextProviderFlowName(name))(
        toChannelRequest(request)
      );
    } catch (e) {
      // v2 says "action <key> not found", v1 answers 404 with the same text.
      if (e instanceof Error && e.message.includes(`${key} not found`)) {
        throw new Error(
          `The app has no context provider "${name}" (expose.contextProvider). ` +
            `Define it with defineContextProvider(ai, { name: '${name}' }, ...) ` +
            `from genkit-channels/app, or a "${contextProviderFlowName(name)}" ` +
            `flow in Go/Python. (${e.message})`
        );
      }
      throw e;
    }
    if (!isRecord(result)) {
      throw new Error(
        `Context provider "${name}" must return an object (the action ` +
          `context), got ${result === null ? 'null' : typeof result}.`
      );
    }
    return result;
  }

  secret(name: string): string {
    const value = process.env[name];
    if (value) return value;
    const declared = this.config.secrets.includes(name);
    throw new Error(
      `Secret "${name}" is not set.` +
        (declared
          ? ' Add it to .env.local for local runs, or create it on the ' +
            'platform (`genkit-channel deploy` lists what is missing).'
          : ` It isn't declared either: add it to \`secrets\` in the ` +
            `channel's channel.yaml.`)
    );
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
    if (this.warmKey) await this.box.warm(this.warmKey);
  }

  listActions(): Promise<Record<string, ActionMetadata>> {
    // The shared/singleton box when there is one; otherwise a throwaway box
    // the box reclaims per retention.
    return this.box.listActions(this.warmKey ?? `list-actions`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMethod(value: string): value is ChannelRequestMethod {
  return (CHANNEL_REQUEST_METHODS as readonly string[]).includes(value);
}

/**
 * Normalizes what a channel has into the wire shape providers see: a known
 * method, lowercase header names, and array header values joined with ", "
 * (as HTTP does).
 */
export function toChannelRequest(request: ContextRequest): ChannelRequest {
  const method = (request.method ?? 'POST').toUpperCase();
  if (!isMethod(method)) {
    throw new Error(
      `Unsupported method "${request.method}" for a context provider ` +
        `(expected one of ${CHANNEL_REQUEST_METHODS.join(', ')}).`
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return {
    method,
    headers,
    input: request.input,
    ...(request.channel ? { channel: request.channel } : {}),
  };
}
