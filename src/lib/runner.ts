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
 * Turns the `box` block of a channel config into `@genkit-ai/box` options:
 * a runner, a route, and a retention.
 */

import {
  SubprocessProvider,
  bubblewrap,
  execRunner,
  localSandbox,
  perRequest,
  podmanRunner,
  sandboxExec,
  singleton,
  type BoxOptions,
  type BoxRunner,
  type SandboxProvider,
} from '@genkit-ai/box';
import path from 'node:path';
import {
  durationMs,
  type BoxConfig,
  type RunnerConfig,
} from './config';
import { withEnvPolicy, type EnvPolicy } from './shims/env-filter';
import { RemoteRunner } from './shims/remote-runner';
import { SessionRouting } from './shims/session-routing';

/** Default env var the remote runner reads its reflection secret from. */
export const REFLECTION_SECRET_ENV = 'GENKIT_REFLECTION_SECRET_TOKEN';

function isolation(name: string | undefined): SandboxProvider {
  switch (name) {
    case undefined:
    case 'none':
      return new SubprocessProvider();
    case 'local':
      return localSandbox();
    case 'bubblewrap':
      return bubblewrap();
    case 'sandbox-exec':
      return sandboxExec();
    default:
      throw new Error(`Unknown box isolate "${name}".`);
  }
}

/** Builds the runner described by `config`, resolving paths from `baseDir`. */
export function buildRunner(
  config: RunnerConfig | undefined,
  box: BoxConfig,
  baseDir: string
): BoxRunner {
  const runner = config ?? { type: 'exec' as const };
  const resolve = (p: string | undefined) =>
    p === undefined ? undefined : path.resolve(baseDir, p);
  const policy: EnvPolicy = { allow: box.env, deny: box.denyEnv };

  switch (runner.type) {
    case 'exec': {
      if (!runner.cmd) {
        throw new Error(
          'box.runner.cmd is not set. Set `runtime.command` on the deployment ' +
            'in channels.yaml, or `box.runner.cmd`.'
        );
      }
      return execRunner({
        cmd: runner.cmd,
        cwd: resolve(runner.cwd),
        isolate: withEnvPolicy(isolation(runner.isolate), policy),
      });
    }
    case 'podman': {
      // Containers inherit nothing, so the env allowlist is passed explicitly
      // (values from this process). denyEnv still wins.
      const deny = new Set(box.denyEnv ?? []);
      const env: Record<string, string> = {};
      for (const name of box.env ?? []) {
        const value = process.env[name];
        if (value !== undefined && !deny.has(name)) env[name] = value;
      }
      return podmanRunner({
        image: runner.image,
        cmd: runner.cmd,
        projectDir: resolve(runner.cwd),
        engine: runner.engine,
        network: runner.network,
        modulesVolume: runner.modulesVolume,
        extraArgs: runner.extraArgs,
        env,
      });
    }
    case 'remote':
      return new RemoteRunner({
        url: runner.url,
        secret: process.env[runner.secretEnv ?? REFLECTION_SECRET_ENV],
        readyTimeoutMs:
          runner.readyTimeout === undefined
            ? undefined
            : durationMs(runner.readyTimeout),
      });
  }
}

/**
 * Resolves the route and retention for `box.route` / `box.idle`. Session
 * routing wraps the runner (see {@link SessionRouting}), so this also returns
 * the runner to use.
 */
export function buildBoxOptions(
  box: BoxConfig,
  runner: BoxRunner
): BoxOptions {
  const retention =
    box.idle === undefined ? undefined : { idle: durationMs(box.idle) };
  switch (box.route ?? 'app') {
    case 'app':
      return { runner, route: singleton, retention };
    case 'request':
      return { runner, route: perRequest, retention };
    case 'session': {
      const routing = new SessionRouting();
      return { runner: routing.wrap(runner), route: routing.route, retention };
    }
  }
}
