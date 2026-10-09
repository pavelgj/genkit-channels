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
 * Compiles one `channels.yaml` deployment into the resolved config
 * `initChannel` reads (`channel.config.json`).
 *
 * The user's `box` block is kept as written, with gaps filled from the rest of
 * the deployment:
 *  - exec/podman `cmd` defaults to the `runtime` command,
 *  - `cwd` defaults to where the app lives (`appDir`),
 *  - the channel manifest's own `env` (e.g. `DISCORD_TOKEN`) is added to
 *    `denyEnv`, so channel secrets never reach the app unless the user
 *    explicitly allows them in `box.env`.
 */

import path from 'path';
import type { BoxConfig, ChannelConfigInput, RunnerConfig } from '../lib/config';
import type { DeploymentManifest, ResolvedRuntime } from './types';

export interface ChannelConfigParts {
  deployment: DeploymentManifest;
  runtime: ResolvedRuntime;
  expose: { agents: string[]; flows: string[] };
  /** Env var names the channel itself needs (from its `channel.yaml`). */
  channelEnv: string[];
  /**
   * Where the app lives, relative to the config file's dir (or absolute).
   * `runtime.cwd` is resolved inside it.
   */
  appDir: string;
}

export function buildChannelConfig(parts: ChannelConfigParts): ChannelConfigInput {
  const { deployment, runtime, expose, channelEnv, appDir } = parts;
  const box: BoxConfig = deployment.box ?? {};
  const appCwd = path.join(appDir, runtime.cwd);
  const runtimeCmd = [runtime.command, ...runtime.args];

  const runner: RunnerConfig = (() => {
    const r = box.runner ?? { type: 'exec' as const };
    switch (r.type) {
      case 'exec':
        return { ...r, cmd: r.cmd ?? runtimeCmd, cwd: r.cwd ?? appCwd };
      case 'podman':
        return { ...r, cmd: r.cmd ?? runtimeCmd, cwd: r.cwd ?? appCwd };
      case 'remote':
        return r;
    }
  })();

  const allowed = new Set(box.env ?? []);
  const denyEnv = dedupe([
    ...(box.denyEnv ?? []),
    ...channelEnv.filter((name) => !allowed.has(name)),
  ]);

  return {
    expose,
    agentState: deployment.expose?.agentState ?? {},
    options: deployment.with ?? {},
    box: {
      ...box,
      runner,
      ...(denyEnv.length > 0 ? { denyEnv } : {}),
    },
  };
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
