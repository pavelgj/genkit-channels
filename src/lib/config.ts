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
 * Schemas for the channel runtime configuration.
 *
 * Two shapes live here:
 *  - {@link BoxConfigSchema}: the `box` block of a deployment in the user's
 *    `channels.yaml`. Maps 1:1 onto `@genkit-ai/box` runners/routes.
 *  - {@link ChannelConfigSchema}: the resolved per-deployment config the CLI
 *    compiles into the staging dir (`channel.config.json`) and `initChannel`
 *    reads. Users don't write this file; it is the `channels.yaml` deployment
 *    with paths and defaults resolved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'genkit';

/** Who owns an agent's session state: a server store, or the caller. */
export const AgentStateSchema = z.enum(['server', 'client']);
export type AgentState = z.infer<typeof AgentStateSchema>;

/** A duration: milliseconds, or a string like `500ms`, `30s`, `10m`, `1h`. */
export const DurationSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+(ms|s|m|h)$/, 'expected e.g. 500ms, 30s, 10m, 1h'),
]);
export type Duration = z.infer<typeof DurationSchema>;

/** A command: a string (split on whitespace) or an argv array. */
const CommandSchema = z.union([z.string().min(1), z.array(z.string()).min(1)]);

/** Local subprocess (optionally OS-sandboxed). Maps to box `execRunner`. */
export const ExecRunnerConfigSchema = z
  .object({
    type: z.literal('exec'),
    /** Defaults to the deployment's `runtime` command (filled by the CLI). */
    cmd: CommandSchema.optional(),
    /** Working dir, relative to the config file. */
    cwd: z.string().optional(),
    isolate: z.enum(['none', 'local', 'bubblewrap', 'sandbox-exec']).optional(),
  })
  .strict();

/** Container with v1 reflection. Maps to box `podmanRunner`. */
export const PodmanRunnerConfigSchema = z
  .object({
    type: z.literal('podman'),
    image: z.string().min(1),
    cmd: CommandSchema.optional(),
    /** Project dir mounted into the container, relative to the config file. */
    cwd: z.string().optional(),
    engine: z.enum(['podman', 'docker']).optional(),
    network: z.enum(['internal', 'bridge']).optional(),
    modulesVolume: z.string().optional(),
    extraArgs: z.array(z.string()).optional(),
  })
  .strict();

/** An already-running runtime serving v1 reflection (e.g. a sidecar). */
export const RemoteRunnerConfigSchema = z
  .object({
    type: z.literal('remote'),
    url: z.string().url(),
    /** Env var holding the reflection secret. */
    secretEnv: z.string().optional(),
    readyTimeout: DurationSchema.optional(),
  })
  .strict();

export const RunnerConfigSchema = z.discriminatedUnion('type', [
  ExecRunnerConfigSchema,
  PodmanRunnerConfigSchema,
  RemoteRunnerConfigSchema,
]);
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>;

/**
 * How the app is boxed. Every field is optional; the default is one long-lived
 * local subprocess running the deployment's `runtime` command.
 */
export const BoxConfigSchema = z
  .object({
    runner: RunnerConfigSchema.optional(),
    /**
     * Which box a call goes to: `app` (one box, the default), `session` (one box
     * per agent session), `request` (a fresh box per call).
     */
    route: z.enum(['app', 'session', 'request']).optional(),
    /** How long an idle box lives. Defaults: app never, session 5m, request 0. */
    idle: DurationSchema.optional(),
    /** If set, the only env vars (beyond basics like PATH) the box receives. */
    env: z.array(z.string()).optional(),
    /** Env vars the box never receives. The CLI adds the channel's own `env`. */
    denyEnv: z.array(z.string()).optional(),
    /** `app` route only: start the box at channel startup, not on first call. */
    warm: z.boolean().optional(),
  })
  .strict();
export type BoxConfig = z.infer<typeof BoxConfigSchema>;

/** The resolved per-deployment config `initChannel` reads. */
export const ChannelConfigSchema = z.object({
  /** Which agents/flows the deployment exposes through the channel. */
  expose: z
    .object({
      agents: z.array(z.string()).default([]),
      flows: z.array(z.string()).default([]),
    })
    .default({}),
  /** State ownership per agent. Unlisted agents default to `server`. */
  agentState: z.record(AgentStateSchema).default({}),
  /** Channel-specific options (the deployment's `with` block). */
  options: z.record(z.unknown()).default({}),
  box: BoxConfigSchema.default({}),
});
export type ChannelConfigInput = z.input<typeof ChannelConfigSchema>;
export type ChannelConfig = z.output<typeof ChannelConfigSchema>;

/** Default config file location (overridable with GENKIT_CHANNEL_CONFIG). */
export const CHANNEL_CONFIG_FILENAME = 'channel.config.json';

/** Formats zod issues as `path: message` lines. */
export function formatZodError(error: z.ZodError, where: string): string {
  const lines = error.issues.map(
    (i) => `  ${[where, ...i.path].join('.')}: ${i.message}`
  );
  return `Invalid ${where}:\n${lines.join('\n')}`;
}

/** Validates a config object, throwing a readable error. */
export function parseChannelConfig(
  input: unknown,
  where = 'channel config'
): ChannelConfig {
  const parsed = ChannelConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error(formatZodError(parsed.error, where));
  return parsed.data;
}

/**
 * Loads the config file. Relative paths inside it (runner `cwd`) resolve
 * against the file's directory, so the same file works locally and in-image.
 */
export function loadChannelConfigFile(configPath?: string): {
  config: ChannelConfig;
  baseDir: string;
} {
  const resolved = path.resolve(
    configPath ||
      process.env.GENKIT_CHANNEL_CONFIG ||
      `./${CHANNEL_CONFIG_FILENAME}`
  );
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `No channel config at ${resolved}. Run the channel through the CLI ` +
        `(genkit-channel deploy <name> --local), set GENKIT_CHANNEL_CONFIG, ` +
        `or pass initChannel({ config }).`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read ${resolved}: ${(e as Error).message}`);
  }
  return {
    config: parseChannelConfig(raw, path.basename(resolved)),
    baseDir: path.dirname(resolved),
  };
}

const DURATION_UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Converts a {@link Duration} to milliseconds. */
export function durationMs(d: Duration): number {
  if (typeof d === 'number') return d;
  const m = /^(\d+)(ms|s|m|h)$/.exec(d);
  if (!m) throw new Error(`Invalid duration "${d}".`);
  return Number(m[1]) * DURATION_UNITS[m[2] as keyof typeof DURATION_UNITS];
}
