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
 * The helper library channel authors use to run a Genkit app as a child process
 * and talk to it over reflection v2 (the JSON-RPC 2.0 over WebSocket protocol).
 *
 * This is the "server" half of reflection v2: the Genkit runtime is the *client*
 * that dials GENKIT_REFLECTION_V2_SERVER and sends `register`. See the reflection
 * v2 protocol docs.
 *
 * Two modes, same code:
 *  - managed:  we spawn the child with the WS URL in its env.
 *  - attached: a sidecar/child is started elsewhere and dials in.
 *
 * A channel usually needs to write almost no plumbing. `startAppProcess()` is
 * synchronous and self-configuring: with no options it reads the framework's
 * `channel.config.json` (path + child.cwd resolution owned by the library),
 * decides managed vs attached mode, and starts in the background. The channel
 * then awaits `ready`, reads its `getConfig()`, and drives discovered actions:
 *
 *   import { startAppProcess } from 'genkit-channels';
 *   const app = startAppProcess();
 *   const { expose, options } = await app.getConfig();
 *   const agent = await app.getAgent(expose.agents[0]);
 *   const chat = agent.chat({ sessionId });
 */

import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  type AgentAPI,
  type CreateAgentApiOptions,
  createAgentApi,
  type DiscoveredAgent,
  discoverAgents,
} from './agent-client';

/** How to launch the user's app (the "child"). */
export interface ChildSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface StartAppProcessOptions {
  /**
   * If provided, spawn this child (managed mode). If omitted, wait for a runtime
   * to connect on its own (attached mode). When neither `child` nor `port` is
   * given, both are derived from the framework's `channel.config.json`.
   */
  child?: ChildSpec;
  /** How long to wait for the child to `register` before giving up. */
  readyTimeoutMs?: number;
  /** Loopback host to bind the WS server to. */
  host?: string;
  /**
   * Fixed port to bind the reflection v2 WS server to. Used in attached mode so
   * a sidecar can dial a known address. When omitted, an ephemeral port is used
   * (managed mode, where the child is told the port via env).
   */
  port?: number;
  /**
   * Skip auto-loading `channel.config.json`. Rarely needed; tests pass an
   * explicit `child`/`port` and there is no config file in their cwd, so the
   * loader is a no-op for them anyway.
   */
  loadConfig?: boolean;
}

/** The channel's view of its composed configuration. */
export interface ChannelConfig<Options = Record<string, unknown>> {
  /** Which discovered actions the deployment asked to expose. */
  expose: { agents: string[]; flows: string[] };
  /** Channel-specific options (the deployment's `with` block). */
  options: Options;
}

/** Result envelope returned by {@link AppProcess.runAction}. */
export interface RunActionResult<T = unknown> {
  result: T;
  telemetry?: { traceId?: string };
}

export interface RunActionParams {
  key: string;
  input?: unknown;
  /**
   * Action initialization data. Passed through to the runtime's `runAction`
   * `init` field. Used by bidi/agent actions (e.g. an agent turn's
   * `snapshotId` / `sessionId` / `state`).
   */
  init?: unknown;
  context?: unknown;
  /** When provided, enables streaming and receives each chunk. */
  onChunk?: (chunk: unknown) => void;
  /** Receives the trace id as soon as the runtime reports it. */
  onTraceId?: (traceId: string) => void;
}

/**
 * The on-disk `channel.config.json` shape the framework writes and the library
 * reads. Channels do not touch this directly; they use {@link AppProcess.getConfig}.
 */
interface RawChannelConfig {
  child?: { command: string; args?: string[]; cwd?: string };
  attach?: { port: number; host?: string };
  expose?: { agents?: string[]; flows?: string[] };
  config?: Record<string, unknown>;
  readyTimeoutMs?: number;
}

/**
 * Reads and normalizes `channel.config.json`. The path is
 * `GENKIT_CHANNEL_CONFIG` or `./channel.config.json`; `child.cwd` is resolved
 * relative to the config file so the same config works locally and in-image.
 * Returns an empty config when the file is missing or unreadable.
 */
function loadChannelConfigFile(): RawChannelConfig {
  const configPath = path.resolve(
    process.env.GENKIT_CHANNEL_CONFIG || './channel.config.json'
  );
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const config = JSON.parse(
      fs.readFileSync(configPath, 'utf8')
    ) as RawChannelConfig;
    if (config.child?.cwd) {
      config.child.cwd = path.resolve(path.dirname(configPath), config.child.cwd);
    }
    return config;
  } catch (e) {
    console.error(
      `[genkit-channels] failed to read ${configPath}: ${(e as Error).message}`
    );
    return {};
  }
}

/**
 * Starts an app process: opens a WS server on a loopback port and, in managed
 * mode, spawns the child with GENKIT_REFLECTION_V2_SERVER set.
 *
 * Synchronous: it returns the handle immediately and does the listen/spawn in
 * the background. Await {@link AppProcess.ready} (or any of the discovery
 * methods, which await it for you) before issuing calls.
 */
export function startAppProcess(
  opts: StartAppProcessOptions = {}
): AppProcess {
  const app = new AppProcess(opts);
  app.start();
  return app;
}

/**
 * Prefix applied to request ids that originate from the dev UI (see the proxy
 * notes on {@link AppProcess}). Keeps the dev UI's id space from colliding with
 * the channel's own request ids on the single runtime link, and lets responses
 * / stream notifications route back to the right consumer.
 */
const UPSTREAM_ID_PREFIX = 'u:';

/**
 * Normalizes a reflection server URL to a `ws://` / `wss://` scheme. `genkit
 * start` may hand us an `http(s)://` URL; the WebSocket client needs a ws scheme.
 */
function toWsUrl(url: string): string {
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`;
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`;
  return url;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
}

interface RpcMessage {
  jsonrpc?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string; data?: unknown };
  id?: string | number | null;
}

export class AppProcess {
  private readonly host: string;
  private readonly readyTimeoutMs: number;
  private readonly childSpec?: ChildSpec;
  private readonly config: RawChannelConfig;

  private wss?: WebSocketServer;
  private ws: WebSocket | null = null;
  private port = 0;
  private child: ChildProcess | null = null;
  private registered = false;
  private started = false;

  /**
   * When we ourselves were launched under `genkit start`, the dev UI hands us
   * *its* reflection v2 server URL in the environment. We keep it so we can act
   * as a proxy: the runtime dials us (managed mode), and we in turn dial the dev
   * UI, presenting the runtime's registration and shuttling requests/streams
   * both ways so the dev UI sees and can drive the app. Undefined when not run
   * under the dev UI (e.g. in production).
   */
  private readonly upstreamUrl?: string;
  /** The link to the dev UI's reflection server (proxy mode only). */
  private upstream: WebSocket | null = null;
  /** Whether the runtime's `register` has been answered (once only). */
  private registerAnswered = false;
  /** Monotonic sequence for namespacing forwarded dev UI request ids. */
  private upstreamSeq = 0;
  /**
   * Maps a forwarded (namespaced) request id sent to the runtime back to the
   * dev UI's original request id, so responses and stream notifications route
   * home with the id the dev UI expects (preserving its original type).
   */
  private readonly upstreamIds = new Map<string, string | number | null>();


  private requestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streamCbs = new Map<string, (chunk: unknown) => void>();
  private readonly traceCbs = new Map<string, (traceId: string) => void>();

  private readyResolve!: () => void;
  private readyReject!: (reason: unknown) => void;
  private readonly readyPromise: Promise<void>;

  constructor(opts: StartAppProcessOptions) {
    this.config =
      opts.loadConfig === false ? {} : loadChannelConfigFile();

    this.host = opts.host || this.config.attach?.host || '127.0.0.1';
    this.readyTimeoutMs =
      opts.readyTimeoutMs ?? this.config.readyTimeoutMs ?? 30000;

    // Managed mode spawns a child; attached mode binds a fixed port and waits.
    // Explicit opts win over the config file.
    this.childSpec = opts.child ?? this.config.child;
    // Seed the port up front so `wsUrl` is correct immediately in attached mode.
    this.port = opts.port ?? this.config.attach?.port ?? 0;

    // If *we* were launched under `genkit start`, the dev UI passed us its own
    // reflection server URL. In that case we proxy the runtime to the dev UI so
    // it can inspect/drive the app (see the proxy fields above). We must not let
    // this value leak into the child's env verbatim, or the child would dial the
    // dev UI directly and bypass the channel; `spawnChild` overwrites it with
    // our own WS URL.
    this.upstreamUrl = process.env.GENKIT_REFLECTION_V2_SERVER || undefined;


    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Avoid an unhandled rejection if the caller never awaits `ready` directly.
    this.readyPromise.catch(() => {});
  }

  /** Begins listening and (managed mode) spawns the child. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;

    const timeout = setTimeout(() => {
      if (!this.registered) {
        this.readyReject(
          new Error(
            `Timed out after ${this.readyTimeoutMs}ms waiting for the runtime ` +
              `to connect and register.`
          )
        );
      }
    }, this.readyTimeoutMs);
    // Don't keep the event loop alive solely for this timer.
    timeout.unref?.();
    this.readyPromise.finally(() => clearTimeout(timeout));

    this.listen()
      .then(() => {
        if (this.childSpec?.command) {
          this.spawnChild(this.childSpec);
        }
      })
      .catch((err) => {
        this.readyReject(
          err instanceof Error ? err : new Error(String(err))
        );
      });
  }

  /** Resolves once the child has connected and registered. */
  get ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * The channel's view of its composed configuration: the resolved `expose`
   * filter and the channel-specific `options` (the deployment's `with` block).
   * Awaits {@link ready} so callers get a consistent post-startup snapshot.
   */
  async getConfig<Options = Record<string, unknown>>(): Promise<
    ChannelConfig<Options>
  > {
    return {
      expose: {
        agents: this.config.expose?.agents ?? [],
        flows: this.config.expose?.flows ?? [],
      },
      options: (this.config.config ?? {}) as Options,
    };
  }

  /** The ws:// URL the child should dial (GENKIT_REFLECTION_V2_SERVER). */
  get wsUrl(): string {
    return `ws://${this.host}:${this.port}`;
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      // A fixed port (attached mode) lets a sidecar dial a known address; port 0
      // lets the OS pick a free ephemeral port (managed mode).
      this.wss = new WebSocketServer({ host: this.host, port: this.port });
      this.wss.on('listening', () => {
        const addr = this.wss!.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        resolve();
      });
      this.wss.on('error', (err) => reject(err));
      this.wss.on('connection', (ws) => {
        // A single runtime per app process. If a new one connects, replace it.
        this.ws = ws;
        ws.on('message', (data) => this.onMessage(data));
        ws.on('error', (err) =>
          console.error('[genkit-channels] ws error', err)
        );
        ws.on('close', () => {
          if (this.ws === ws) this.ws = null;
        });
      });
    });
  }

  private spawnChild(child: ChildSpec): void {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(child.env || {}),
      GENKIT_REFLECTION_V2_SERVER: this.wsUrl,
      // The reflection v2 client only activates when GENKIT_ENV=dev in both the
      // JS and Go runtimes. A channel rides on the reflection link, so the child
      // must run in that mode even though we are "in production". This is the
      // prototype reality: reflection is dev-oriented and not yet hardened.
      GENKIT_ENV: child.env?.GENKIT_ENV || 'dev',
    };
    // The channel owns the public $PORT. The child should be headless (it talks
    // over reflection v2, not its own transport), so don't hand it our PORT and
    // risk a bind collision.
    delete env.PORT;

    const proc = spawn(child.command, child.args || [], {
      cwd: child.cwd,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    this.child = proc;
    proc.on('error', (err) => {
      this.readyReject(
        new Error(`Failed to start child process: ${err.message}`)
      );
    });
    proc.on('exit', (code, signal) => {
      if (!this.registered) {
        this.readyReject(
          new Error(
            `Child process exited before registering ` +
              `(code=${code}, signal=${signal}).`
          )
        );
      } else if (code && code !== 0 && !signal) {
        // The child died after serving; take the process down with it so the
        // platform restarts the whole unit.
        console.error(`[genkit-channels] child exited with code ${code}`);
        process.exit(code);
      }
    });
  }

  private onMessage(data: unknown): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(String(data));
    } catch (e) {
      console.error('[genkit-channels] bad message', e);
      return;
    }
    if (msg.method) {
      this.onRequestOrNotification(msg);
    } else if (msg.id !== undefined) {
      this.onResponse(msg);
    }
  }

  private onRequestOrNotification(msg: RpcMessage): void {
    switch (msg.method) {
      case 'register':
        this.onRegister(msg);
        break;
      case 'streamChunk': {
        const { requestId } = msg.params || {};
        // A stream chunk for a forwarded dev UI request belongs upstream, not to
        // a local callback. Route it home and stop.
        if (this.forwardNotificationUpstream(msg, requestId)) break;
        this.streamCbs.get(String(requestId))?.(msg.params?.chunk);
        break;
      }
      case 'runActionState': {
        const { requestId, state } = msg.params || {};
        if (this.forwardNotificationUpstream(msg, requestId)) break;
        if (state?.traceId)
          this.traceCbs.get(String(requestId))?.(state.traceId);
        break;
      }
      default:
        // Ignore unknown notifications.
        break;
    }
  }

  private onRegister(msg: RpcMessage): void {
    this.registered = true;
    // Respond with an empty result (no telemetry server configured).
    if (msg.id !== undefined && msg.id !== null) {
      this.send({ jsonrpc: '2.0', result: {}, id: msg.id });
    }
    // If we are running under the dev UI, present this runtime to it now that it
    // has registered with us. The dev UI then drives the app *through* us.
    if (this.upstreamUrl) {
      this.connectUpstream(msg.params);
    }
    this.readyResolve();
  }

  private onResponse(msg: RpcMessage): void {
    // A response to a request we forwarded on the dev UI's behalf: route it back
    // to the dev UI under its original id, not to a local pending entry.
    const id = String(msg.id);
    if (id.startsWith(UPSTREAM_ID_PREFIX)) {
      const originalId = this.upstreamIds.get(id);
      this.upstreamIds.delete(id);
      this.sendUpstream({ ...msg, id: originalId ?? null });
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (msg.error) {
      const err = new Error(msg.error.message || 'runtime error') as Error & {
        data?: unknown;
      };
      err.data = msg.error.data;
      pending.reject(err);
    } else {
      pending.resolve(msg.result);
    }
  }

  // --- Dev UI proxy ---------------------------------------------------------
  //
  // When `genkit start` launches the channel it passes its own reflection v2
  // server URL in the environment. The runtime, however, must dial *us* so the
  // channel can drive it. To keep the dev UI working, we bridge the two: the
  // runtime connects here (managed mode) and we relay its registration, action
  // list, runs and streams to/from the dev UI. From the dev UI's perspective the
  // channel process *is* the runtime.

  /**
   * Opens the link to the dev UI's reflection server and registers this runtime
   * with it, forwarding the runtime's own `register` params (pid, name, version)
   * so the dev UI shows the real app. Idempotent: only the first runtime
   * registration dials out.
   */
  private connectUpstream(registerParams: unknown): void {
    if (this.registerAnswered) return;
    this.registerAnswered = true;

    const url = toWsUrl(this.upstreamUrl!);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      console.error(
        `[genkit-channels] failed to dial dev UI at ${url}: ` +
          `${(e as Error).message}`
      );
      return;
    }
    this.upstream = socket;

    socket.on('open', () => {
      // Present the runtime to the dev UI. Its reply is a plain ack we ignore.
      this.sendUpstream({
        jsonrpc: '2.0',
        method: 'register',
        params: registerParams,
        id: `${UPSTREAM_ID_PREFIX}register`,
      });
    });
    socket.on('message', (data) => this.onUpstreamMessage(data));
    socket.on('error', (err) =>
      console.error('[genkit-channels] dev UI link error', err.message)
    );
    socket.on('close', () => {
      if (this.upstream === socket) this.upstream = null;
    });
  }

  /** Handles a message from the dev UI: forward its requests to the runtime. */
  private onUpstreamMessage(data: unknown): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(String(data));
    } catch (e) {
      console.error('[genkit-channels] bad dev UI message', e);
      return;
    }
    // The dev UI issues requests (listActions, runAction, cancelAction, ...).
    // Anything without a method is a response to our own `register` and needs no
    // handling.
    if (!msg.method) return;

    // Namespace the dev UI's id so its request space cannot collide with the
    // channel's own requests on the shared runtime link, and remember the
    // original so the response / stream notifications can route home.
    const forwardedId = `${UPSTREAM_ID_PREFIX}${++this.upstreamSeq}`;
    if (msg.id !== undefined) {
      this.upstreamIds.set(forwardedId, msg.id ?? null);
    }
    this.send({
      jsonrpc: '2.0',
      method: msg.method,
      params: msg.params,
      id: msg.id === undefined ? undefined : forwardedId,
    });
  }

  /**
   * If `requestId` names a forwarded dev UI request, relays the notification to
   * the dev UI under its original request id and returns true (handled).
   * Otherwise returns false so the local stream/trace callbacks run.
   */
  private forwardNotificationUpstream(
    msg: RpcMessage,
    requestId: unknown
  ): boolean {
    const key = String(requestId);
    if (!key.startsWith(UPSTREAM_ID_PREFIX)) return false;
    const originalId = this.upstreamIds.get(key);
    if (originalId === undefined) return false;
    this.sendUpstream({
      ...msg,
      params: { ...msg.params, requestId: originalId },
    });
    return true;
  }

  /** Sends a message to the dev UI link, if connected. */
  private sendUpstream(obj: RpcMessage): void {
    if (this.upstream && this.upstream.readyState === this.upstream.OPEN) {
      this.upstream.send(JSON.stringify(obj));
    }
  }


  private send(obj: RpcMessage): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Sends a request and awaits the correlated response (no timeout). */
  private request(
    method: string,
    params?: unknown,
    cbs: {
      onChunk?: (chunk: unknown) => void;
      onTraceId?: (traceId: string) => void;
    } = {}
  ): Promise<any> {
    const id = String(++this.requestId);
    if (cbs.onChunk) this.streamCbs.set(id, cbs.onChunk);
    if (cbs.onTraceId) this.traceCbs.set(id, cbs.onTraceId);
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', method, params, id });
    }).finally(() => {
      this.streamCbs.delete(id);
      this.traceCbs.delete(id);
    });
  }

  /** Returns the map of action key -> action metadata. Awaits {@link ready}. */
  async listActions(): Promise<Record<string, unknown>> {
    await this.ready;
    const res = await this.request('listActions');
    return res?.actions || {};
  }

  /**
   * Lists the agents the app exposes, with the capability metadata a channel
   * needs to drive them. Awaits {@link ready}.
   */
  async listAgents(): Promise<DiscoveredAgent[]> {
    const actions = await this.listActions();
    return discoverAgents(actions);
  }

  /**
   * Resolves an ergonomic {@link AgentAPI} for one of the app's agents. Pass a
   * short name (`weatherAgent`) or a full key (`/agent/weatherAgent`); with no
   * argument the sole exposed agent is used (throwing on zero or many). Awaits
   * {@link ready}.
   */
  async getAgent<State = unknown>(
    nameOrKey?: string
  ): Promise<AgentAPI<State>> {
    const agents = await this.listAgents();
    const selected = selectAgent(agents, nameOrKey);
    return createAgentApi<State>(this, {
      key: selected.key,
      stateManagement: selected.stateManagement,
    });
  }

  /** Runs an action, optionally streaming chunks. */
  runAction<T = unknown>({
    key,
    input,
    init,
    context,
    onChunk,
    onTraceId,
  }: RunActionParams): Promise<RunActionResult<T>> {
    return this.request(
      'runAction',
      { key, input, init, context, stream: !!onChunk },
      { onChunk, onTraceId }
    );
  }

  /** Cancels an in-flight action by trace id. */
  cancelAction(traceId: string): Promise<void> {
    return this.request('cancelAction', { traceId })
      .then(() => undefined)
      .catch(() => undefined);
  }

  /** Forwards a signal to the child and closes the server. */
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    try {
      this.wss?.close();
    } catch {
      // ignore
    }
    try {
      this.upstream?.close();
    } catch {
      // ignore
    }
    if (this.child && this.child.exitCode === null) {
      this.child.kill(signal);
    }
  }
}

/**
 * Chooses a discovered agent by short name or `/agent/<name>` key. With no
 * `nameOrKey`, requires exactly one agent. Throws a helpful error otherwise.
 */
function selectAgent(
  agents: DiscoveredAgent[],
  nameOrKey?: string
): DiscoveredAgent {
  if (nameOrKey) {
    const key = nameOrKey.startsWith('/agent/')
      ? nameOrKey
      : `/agent/${nameOrKey}`;
    const found = agents.find((a) => a.key === key || a.name === nameOrKey);
    if (!found) {
      const names = agents.map((a) => a.name).join(', ') || '(none)';
      throw new Error(
        `agent "${nameOrKey}" not found among discovered agents: ${names}`
      );
    }
    return found;
  }
  if (agents.length === 1) return agents[0];
  if (agents.length === 0) {
    throw new Error(
      'no agents discovered; this channel needs an agent (define one with ' +
        'ai.defineAgent and expose it).'
    );
  }
  const names = agents.map((a) => a.name).join(', ');
  throw new Error(
    `multiple agents discovered (${names}); pass a name to getAgent() to pick one.`
  );
}

export type { AgentAPI, CreateAgentApiOptions, DiscoveredAgent };
