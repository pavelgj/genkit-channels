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
 * Types shared across the genkit-channels implementation.
 *
 * A channel reaches the user's app through `@genkit-ai/box`: the app runs in a
 * box (subprocess, sandbox, container, or remote runtime) and the channel
 * drives it through proxies. No user code is generated or imported.
 */

import type {
  AgentState,
  BoxConfig,
  ChannelConfigInput,
} from '../lib/config';
import type { DeploymentSecrets, ResolvedSecret } from './secrets';

/**
 * A channel name is a free-form string mapping to a directory under
 * `.genkit/channels/<name>/`. Channels are pluggable and fetched with
 * `genkit-channels add`.
 */
export type ChannelName = string;

/**
 * A deploy target name. Backed by the target registry (see `core/targets`);
 * typed as a string so new targets can register without a type change. Use
 * `isKnownTarget` / the registry to validate at runtime.
 */
export type TargetName = string;

/** Languages a user's app can be written in (drives the runtime builder). */
export type RuntimeLanguage = 'js' | 'go' | 'python';

/**
 * The language a channel itself is written in. Node only for now: channels build
 * on `initChannel` / `@genkit-ai/box`, which are JS. Kept as a field so other
 * languages can return once box has ports.
 */
export type ChannelLanguage = 'node';

/**
 * How a composed artifact is packaged for a target.
 *  - `single-container`: one image runs the channel, which boxes the user app
 *    as a local subprocess. Self-contained, uses buildpacks/`--source`.
 *  - `sidecar`: two images (channel + user app) run as sibling containers; the
 *    channel calls the app's loopback reflection server (remote box runner).
 *    Better isolation.
 */
export type PackagingName = 'single-container' | 'sidecar';


/**
 * Whether a service is reachable without authentication.
 *  - `private`: only authenticated callers (default; secure).
 *  - `public`: anyone can reach it (Cloud Run: allow-unauthenticated).
 */
export type ServiceAccess = 'public' | 'private';

/**
 * CPU allocation policy.
 *  - `request-only`: CPU is throttled outside of request handling (default;
 *    cheapest; fine for request/response workloads).
 *  - `always-allocated`: CPU is always on (Cloud Run: no-cpu-throttling).
 *    Needed for background work between requests, e.g. a persistent WebSocket.
 */
export type ServiceCpu = 'request-only' | 'always-allocated';

/**
 * Portable, curated service runtime settings. Every field is optional; unset
 * fields fall back to a channel recommendation and then a secure built-in
 * default (see resolveServiceSettings). Named platform-neutrally; the target
 * translates them (Cloud Run flags / Knative annotations).
 */
export interface ServiceSettings {
  /** Public vs private access. Never silently escalated to public. */
  access?: ServiceAccess;
  /** CPU allocation policy. */
  cpu?: ServiceCpu;
  /** Minimum warm instances (>= 1 keeps one always running and billed). */
  minInstances?: number;
  /** Maximum instances to scale to. */
  maxInstances?: number;
  /** Max concurrent requests per instance. */
  concurrency?: number;
  /** Memory limit, e.g. `512Mi` or `1Gi`. */
  memory?: string;
}

/**
 * Service settings after resolving user values over channel recommendations
 * over built-in defaults. `access` and `cpu` are always present; the rest are
 * only set when configured somewhere.
 */
export interface ResolvedServiceSettings {
  access: ServiceAccess;
  cpu: ServiceCpu;
  minInstances?: number;
  maxInstances?: number;
  concurrency?: number;
  memory?: string;
}


/**
 * Which agents and flows the channel exposes. This is the source of truth for
 * what the app offers: channels don't discover actions at serve time, since a
 * boxed app may not be running yet.
 */
export interface ExposeConfig {
  /** Convenience for a single agent (equivalent to `agents: [name]`). */
  agent?: string;
  agents?: string[];
  flows?: string[];
  /**
   * State ownership per agent: `server` (has a session store; the default) or
   * `client` (the caller round-trips the state).
   */
  agentState?: Record<string, AgentState>;
}

/**
 * How to build and launch the user's app. Defaults come from the per-language
 * runtime builder; every field here is an optional override.
 */
export interface RuntimeConfig {
  language: RuntimeLanguage;
  /** Build command run at compose/image-build time (e.g. `go build ...`). */
  build?: string;
  /** Command that starts the (headless) app; becomes the channel child. */
  command?: string;
  /** Args for `command`. */
  args?: string[];
  /** Entry module/path (used by some languages to derive command). */
  entry?: string;
  /** Working directory for build/run, relative to the project root. */
  cwd?: string;
}

/**
 * Configures the built-in agent-dir runtime. Used when a deployment declares no
 * `runtime` of its own (or wants to tweak the defaults). The framework spawns a
 * headless Genkit app that loads `dir` and installs the default middleware and
 * model providers (see the agent-dir helper). Every field is optional.
 */
export interface AgentDirConfig {
  /** Directory of agent folders, relative to the project. Default `./agents`. */
  dir?: string;
  /** Model applied to an agent whose prompt omits one. */
  model?: string;
}

/** A single deployment entry from the manifest. */
export interface DeploymentManifest {
  /** Unique deployment name; also the default platform service name. */
  name: string;
  /** Name of an installed channel. */
  channel: ChannelName;
  /**
   * How to build/run the user's app. Optional: when omitted, the framework runs
   * the built-in agent-dir runtime, loading agents from `agents.dir` (default
   * `./agents`). Provide a `runtime` to run your own Genkit app instead.
   */
  runtime?: RuntimeConfig;
  /**
   * Configuration for the built-in agent-dir runtime (directory, default model).
   * Honored whether or not a `runtime` is set; with no `runtime` it also selects
   * the built-in runtime.
   */
  agents?: AgentDirConfig;

  /** Which agents and flows the channel exposes. */
  expose?: ExposeConfig;
  /**
   * How the app is boxed: runner (exec, podman, remote), isolation, routing,
   * idle retention, env allowlist. Optional; the default is one long-lived
   * local subprocess running `runtime`.
   */
  box?: BoxConfig;
  /** Where to run it. */
  target?: TargetName;
  /**
   * How to package the artifact. Defaults to the target's default packaging
   * (Cloud Run: `single-container`). `sidecar` runs the channel and the user
   * app as sibling containers.
   */
  packaging?: PackagingName;
  /** Target region (Cloud Run). */
  region?: string;
  /**
   * Non-secret env var names to forward to the running service (values come
   * from the deploy environment and are set as plain env).
   */
  env?: string[];
  /**
   * Secrets the app needs (env var names), or a map from name to a platform
   * reference when the platform's name differs (Cloud Run: a Secret Manager
   * secret name, `name@version`, or a full resource name). Channel secrets come
   * from the channel's `channel.yaml`; list them here only to remap them.
   */
  secrets?: DeploymentSecrets;
  /** Override the platform service name (defaults to `name`). */
  serviceName?: string;
  /**
   * Container image repository to push built images to (sidecar packaging on
   * Cloud Run). E.g. `us-central1-docker.pkg.dev/PROJECT/genkit-channels`. Image
   * tags are derived from the deployment name.
   */
  imageRepo?: string;
  /**
   * Portable service runtime settings (access, cpu, scaling, memory). These win
   * over any channel recommendation. `access` is never escalated to `public`
   * from a recommendation alone; the user must set it here.
   */
  service?: ServiceSettings;
  /**
   * Arbitrary channel-specific configuration, passed through to the channel
   * (as `config` in `channel.config.json`) and to validation rules.
   */
  with?: Record<string, unknown>;
}



/** Root manifest shape (channels.yaml). */
export interface DeployConfig {
  deployments: DeploymentManifest[];
}

/**
 * A single JSONata rule declared by a channel. For `validate` rules, a falsy
 * result fails the deploy; for `warn` rules, a truthy result logs a warning.
 */
export interface ChannelRule {
  /** JSONata expression evaluated against the compose context. */
  expr: string;
  /** Message shown when the rule triggers. */
  message: string;
}

/**
 * How to build a channel's own container image: run the copied source after
 * `npm install`, or after the channel's declared `build`. The channel-side
 * analog of {@link DockerfilePlan}.
 */
export interface ChannelBuildPlan {
  /** The language the channel is written in. */
  language: ChannelLanguage;
  /**
   * Base image for the final runtime image of the channel (single-container:
   * this is the whole image's base; sidecar: the channel container's base).
   */
  runtimeImage: string;
  /**
   * Shell commands (Dockerfile RUN lines, without the `RUN` keyword) that build
   * the channel, e.g. `npm install --omit=dev` in the channel dir.
   */
  buildSteps: string[];
  /**
   * The command (argv) that launches the channel inside the final image, e.g.
   * `["node", "/app/channel/src/index.js"]`.
   */
  runCommand: string[];
}

/** Parsed channel.yaml (the channel manifest). */
export interface ChannelDefinition {
  name: string;
  description?: string;
  version?: string;
  /** The language the channel is implemented in (default: `node`). */
  language: ChannelLanguage;
  /**
   * JS entry to run, relative to the channel dir (e.g. `src/index.js`, or
   * `dist/index.js` for a channel with a `build`).
   */
  entry: string;
  /**
   * Build command for the channel itself, run relative to the channel dir at
   * install and image-build time (e.g. `npm install && npm run build` for
   * TypeScript). Plain JS channels omit this (`npm install` is implied).
   */
  build?: string;
  /**
   * A prebuilt/published channel image reference. When set, sidecar packaging
   * can skip building the channel image and use this directly.
   */
  image?: string;
  /** Non-secret env var names the channel itself reads. */
  env?: string[];
  /**
   * Secrets the channel itself needs (env var names, e.g. `DISCORD_TOKEN`).
   * Delivered to the channel process only, never to the boxed app.
   */
  secrets?: string[];
  /** JSONata rules that fail the deploy when falsy. */
  validate?: ChannelRule[];
  /** JSONata rules that log a warning when truthy. */
  warn?: ChannelRule[];
  /**
   * Service settings this channel recommends as defaults (e.g. a WebSocket
   * channel recommends `cpu: always-allocated` + `minInstances: 1`). These are
   * applied only when the user has not set the corresponding field. A `public`
   * access recommendation is surfaced as a notice, never auto-applied.
   */
  recommends?: { service?: ServiceSettings };
  /** Absolute directory the definition was loaded from. */
  dir: string;
}



/**
 * The context handed to channel JSONata rules at compose time. `actions` is not
 * available here (it is only known to the channel at runtime after
 * `listActions`).
 */
export interface ComposeContext {
  /** Raw manifest entry. */
  deployment: DeploymentManifest;
  /** Resolved expose filter. */
  expose: { agents: string[]; flows: string[] };
  /** Passthrough of `deployment.with`. */
  config: Record<string, unknown>;
  /** Env var names (manifest env + channel env). */
  env: string[];
  /** The resolved child command/args/cwd. */
  child: { command: string; args: string[]; cwd: string };
}


/** Result of a per-language runtime builder resolving a deployment. */
export interface ResolvedRuntime {
  /** The user app language this runtime was resolved for. */
  language: RuntimeLanguage;
  /** Command that starts the headless app (the channel child). */
  command: string;
  args: string[];

  /** Working dir for the child, relative to the staging `user/` dir. */
  cwd: string;
  /** Build command run before start (image build / local build). */
  build?: string;
  /** Dockerfile builder stage lines for this language. */
  dockerfile: DockerfilePlan;
}

/** The pieces a runtime contributes to the generated multi-stage Dockerfile. */
export interface DockerfilePlan {
  /** Base image for the build stage (e.g. `golang:1.23`). */
  builderImage: string;
  /** Shell commands run in the build stage to produce the app artifact. */
  buildSteps: string[];
  /** Files/dirs to copy from the build stage into the final image. */
  copyArtifacts: Array<{ from: string; to: string }>;
  /** Extra runtime packages to install in the final image, if any. */
  runtimeSetup?: string[];
}

/** The channel entry (relative to the staging dir) plus how to launch it. */
export interface ChannelPlan {
  /** The installed channel definition. */
  definition: ChannelDefinition;
  /** Channel entry relative to the staging dir (e.g. `channel/src/index.js`). */
  entryFromStaging: string;
  /** How to build the channel's own image. */
  build: ChannelBuildPlan;
}

/**
 * The neutral output of {@link compose}. compose gathers ingredients (channel
 * copy, user copy, `channel.config.json`) and describes how to build both sides;
 * it does not decide packaging. Targets consume this to generate their artifacts
 * (Dockerfile, service spec, ...) and ship them.
 */
export interface ComposePlan {
  /** Absolute path to the staging dir with `channel/`, `user/`, config. */
  stagingDir: string;
  /**
   * True when this deployment uses the built-in agent-dir runtime (no `runtime`
   * in the manifest). The "user app" was synthesized into the staging `user/`
   * dir, so a local run must launch from there rather than the project dir.
   */
  usingAgentDir: boolean;
  /** Resolved user runtime (child command + Dockerfile build stage). */
  runtime: ResolvedRuntime;

  /** Resolved channel (entry + channel image build plan). */
  channel: ChannelPlan;
  /** Resolved expose filter. */
  expose: { agents: string[]; flows: string[] };
  /** Passthrough of `deployment.with`. */
  config: Record<string, unknown>;
  /** Env var names to forward (channel env + manifest env). */
  env: string[];
  /**
   * Every secret the deployment needs (channel + app), with who receives it
   * and its platform reference. Values are never part of the plan.
   */
  secrets: ResolvedSecret[];
  /**
   * Rewrites `channel.config.json` in the staging dir. Targets use this to
   * change how the app is boxed (e.g. sidecar switches to a remote runner).
   */
  writeChannelConfig(config: ChannelConfigInput): void;
  /** The config compose wrote by default (exec runner over `user/`). */
  channelConfig: ChannelConfigInput;
  /**
   * The channel config with the app located at `appDir` instead of the staged
   * `user/` copy. `--local` uses this to run the original project in place.
   */
  channelConfigFor(appDir: string): ChannelConfigInput;
}

/** Context passed to a deploy target. */
export interface DeployTargetContext {
  deployment: DeploymentManifest;
  stagingDir: string;
  /** The neutral compose plan; targets own artifact generation from here. */
  plan: ComposePlan;
  /** Resolved packaging (deployment.packaging or the target default). */
  packaging: PackagingName;
  /**
   * Service runtime settings resolved from user values, channel recommendations
   * and secure defaults. Targets translate these to platform knobs.
   */
  serviceSettings: ResolvedServiceSettings;
  /** When false, targets should print what they would do without executing. */
  execute: boolean;
}



/** A pluggable deployment platform. */
export interface DeployTarget {
  name: TargetName;
  /** Packagings this target can ship. */
  supportedPackagings: PackagingName[];
  /** Packaging used when the deployment does not specify one. */
  defaultPackaging: PackagingName;
  /** Verify prerequisites (e.g. gcloud installed + authed); throw on error. */
  validate(ctx: DeployTargetContext): Promise<void>;
  /** Ship the staging dir. */
  deploy(ctx: DeployTargetContext): Promise<{ url?: string }>;
}

