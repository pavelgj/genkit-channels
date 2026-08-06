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
 * A channel runs the user's app as a child process and talks to it over
 * reflection v2, discovering actions at runtime. It does not generate or import
 * user code.
 */

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
 * The language a channel itself is written in. Channels are compiled/run
 * differently (Node runs source; Go ships a static binary), which drives how the
 * channel's own container image is built.
 */
export type ChannelLanguage = 'node' | 'go';

/**
 * How a composed artifact is packaged for a target.
 *  - `single-container`: one image runs the channel, which spawns the user app
 *    as a child (managed mode). Self-contained, uses buildpacks/`--source`.
 *  - `sidecar`: two images (channel + user app) run as sibling containers; the
 *    app dials the channel over loopback (attached mode). Better isolation.
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


/** Which discovered actions to expose through the channel (runtime filter). */
export interface ExposeConfig {

  /** Convenience for a single agent (equivalent to `agents: [name]`). */
  agent?: string;
  agents?: string[];
  flows?: string[];
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

/** A single deployment entry from the manifest. */
export interface DeploymentManifest {
  /** Unique deployment name; also the default platform service name. */
  name: string;
  /** Name of an installed channel. */
  channel: ChannelName;
  /** How to build/run the user's app. */
  runtime: RuntimeConfig;
  /** Which discovered actions to expose (default: all). */
  expose?: ExposeConfig;
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
  /** Env var names to forward to the running service (and the child). */
  env?: string[];
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
 * How to build a channel's own container image. Declared per channel because a
 * Node channel runs source with an `npm install`, while a Go channel compiles to
 * a static binary. This is the channel-side analog of {@link DockerfilePlan}.
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
   * Base image for a build stage, when the channel must be compiled (Go). Omit
   * for interpreted channels (Node) that run their copied source directly.
   */
  builderImage?: string;
  /**
   * Shell commands (Dockerfile RUN lines, without the `RUN` keyword) that build
   * the channel. For Node: `npm install --omit=dev` in the channel dir. For Go:
   * `go build -o ...` in the build stage.
   */
  buildSteps: string[];
  /**
   * The command (argv) that launches the channel inside the final image, e.g.
   * `["node", "/app/channel/src/index.js"]` or `["/app/channel/bin/app"]`.
   */
  runCommand: string[];
}

/** Parsed channel.yaml. Channels may be written in Node or Go. */
export interface ChannelDefinition {
  name: string;
  description?: string;
  version?: string;
  /** The language the channel is implemented in (default: `node`). */
  language: ChannelLanguage;
  /**
   * Entry to run, relative to the channel dir. For Node this is the JS entry
   * (e.g. `src/index.js`); for Go it is the built binary (e.g. `bin/app`).
   */
  entry: string;
  /**
   * Build command for the channel itself, run relative to the channel dir at
   * image-build time (e.g. `go build -o bin/app .`). Node channels usually omit
   * this (their `npm install` is derived from the build plan).
   */
  build?: string;
  /**
   * A prebuilt/published channel image reference. When set, sidecar packaging
   * can skip building the channel image and use this directly.
   */
  image?: string;
  /** Env var names the channel itself needs (surfaced in .env.example). */
  env?: string[];
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

/**
 * The `channel.config.json` written into the staging dir and read by the channel
 * at startup.
 *
 * In managed mode (`child` present) the channel spawns the user app on an
 * ephemeral loopback port. In attached mode (`child` omitted, `attach` present)
 * the channel binds a fixed loopback port and waits for a sidecar to dial in.
 */
export interface ChannelRuntimeConfig {
  /** Managed mode: how to spawn the user app as a child. */
  child?: { command: string; args: string[]; cwd: string };
  /**
   * Attached mode: bind the reflection v2 WS server on this fixed loopback port
   * and wait for a separately started app (sidecar) to connect. Mutually
   * exclusive with `child`.
   */
  attach?: { port: number; host?: string };
  expose: { agents: string[]; flows: string[] };
  config: Record<string, unknown>;
  readyTimeoutMs: number;
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
   * Rewrites `channel.config.json` in the staging dir. Targets use this to flip
   * the channel between managed and attached mode (e.g. sidecar sets `attach`
   * and drops `child`).
   */
  writeChannelConfig(config: ChannelRuntimeConfig): void;
  /** The managed-mode config compose wrote by default (child + ephemeral WS). */
  managedConfig: ChannelRuntimeConfig;
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

