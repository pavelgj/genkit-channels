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
  remoteRunner,
  sandboxExec,
  sessionRoute,
  singleton,
  type BoxOptions,
  type BoxRunner,
  type InheritEnv,
  type SandboxProvider,
} from '@genkit-ai/box';
import path from 'node:path';
import {
  durationMs,
  type BoxConfig,
  type Duration,
  type RunnerConfig,
} from './config';

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

/**
 * Which inherited env vars the box gets, from `box.env` (allowlist) and
 * `box.denyEnv`. Box takes an allowlist only, so "everything except the denied
 * vars" becomes an allowlist of the current env minus those. Box always keeps
 * its BASE_ENV basics (PATH, HOME, locale, ...), even if denied.
 */
export function inheritEnvFor(
  box: BoxConfig,
  env: NodeJS.ProcessEnv = process.env
): InheritEnv {
  const deny = new Set(box.denyEnv ?? []);
  if (box.env) return box.env.filter((name) => !deny.has(name));
  if (deny.size === 0) return true;
  return Object.keys(env).filter((name) => !deny.has(name));
}

function ms(d: Duration | undefined): number | undefined {
  return d === undefined ? undefined : durationMs(d);
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
        isolate: isolation(runner.isolate),
        inheritEnv: inheritEnvFor(box),
        readyTimeoutMs: ms(runner.readyTimeout),
      });
    }
    case 'podman': {
      // Containers inherit nothing, so the allowlist is passed explicitly with
      // values from this process. denyEnv still wins.
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
        readyTimeoutMs: ms(runner.readyTimeout),
        env,
      });
    }
    case 'remote':
      return remoteRunner({
        url: runner.url,
        secret: process.env[runner.secretEnv ?? REFLECTION_SECRET_ENV],
        readyTimeoutMs: ms(runner.readyTimeout),
      });
  }
}

/** Resolves the route and retention for `box.route` / `box.idle`. */
export function buildBoxOptions(
  box: BoxConfig,
  runner: BoxRunner
): BoxOptions {
  const retention =
    box.idle === undefined ? undefined : { idle: durationMs(box.idle) };
  const route = { app: singleton, request: perRequest, session: sessionRoute }[
    box.route ?? 'app'
  ];
  return { runner, route, retention };
}
