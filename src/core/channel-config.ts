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
 *  - secrets are routed by who declared them: channel secrets (from its
 *    `channel.yaml`, e.g. `DISCORD_TOKEN`) are added to `denyEnv`, so they
 *    never reach the app unless the user explicitly lists them in `box.env`;
 *    app secrets are added to `box.env` when the user set an allowlist, so
 *    they don't have to be listed twice,
 *  - the channel's secret names (never values) are recorded so
 *    `initChannel` can check them at startup.
 */

import path from 'path';
import type {
  BoxConfig,
  ChannelConfigInput,
  Expose,
  RunnerConfig,
} from '../lib/config';
import type { ResolvedSecret } from './secrets';
import type { DeploymentManifest, ResolvedRuntime } from './types';

export interface ChannelConfigParts {
  deployment: DeploymentManifest;
  runtime: ResolvedRuntime;
  expose: Expose;
  /** Every secret of the deployment, routed to channel or app. */
  secrets: readonly ResolvedSecret[];
  /**
   * Where the app lives, relative to the config file's dir (or absolute).
   * `runtime.cwd` is resolved inside it.
   */
  appDir: string;
}

export function buildChannelConfig(parts: ChannelConfigParts): ChannelConfigInput {
  const { deployment, runtime, expose, secrets, appDir } = parts;
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

  const channelSecrets = secrets
    .filter((s) => s.consumer === 'channel')
    .map((s) => s.name);
  const appSecrets = secrets
    .filter((s) => s.consumer === 'app')
    .map((s) => s.name);

  const allowed = new Set(box.env ?? []);
  const denyEnv = dedupe([
    ...(box.denyEnv ?? []),
    ...channelSecrets.filter((name) => !allowed.has(name)),
  ]);
  // Without an allowlist an exec box inherits everything not denied, app
  // secrets included. With one, app secrets join it. Containers inherit
  // nothing, so a podman box always gets its secrets passed explicitly.
  const env =
    box.env || runner.type === 'podman'
      ? dedupe([...(box.env ?? []), ...appSecrets])
      : undefined;

  return {
    expose,
    agentState: deployment.expose?.agentState ?? {},
    options: deployment.with ?? {},
    secrets: channelSecrets,
    box: {
      ...box,
      runner,
      ...(env ? { env } : {}),
      ...(denyEnv.length > 0 ? { denyEnv } : {}),
    },
  };
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
