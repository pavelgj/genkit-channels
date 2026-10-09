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

// TODO(box): FR-1. Replace with `execRunner({ env, inheritEnv })` once box
// can control the child's environment.

import type {
  PreparedSpawn,
  ReflectHost,
  SandboxProvider,
  SpawnSpec,
} from '@genkit-ai/box';

/** Which inherited env vars a box child may see. */
export interface EnvPolicy {
  /** If set, only these (plus {@link ALWAYS_KEEP}) are inherited. */
  allow?: string[];
  /** Never inherited, even when allowed. */
  deny?: string[];
}

/**
 * Inherited vars that are always kept: the box's own reflection wiring
 * (`GENKIT_*`, set by execRunner after it spreads `process.env`) and the basics
 * a runtime needs to start.
 */
const ALWAYS_KEEP = [
  /^GENKIT_/,
  /^NODE_/,
  /^LC_/,
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|TZ|TERM)$/,
  /^(SSL_CERT_FILE|SSL_CERT_DIR)$/,
];

/** Computes which of the current process's env vars the child must not see. */
export function varsToUnset(
  policy: EnvPolicy,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const allow = policy.allow ? new Set(policy.allow) : undefined;
  const deny = new Set(policy.deny ?? []);
  return Object.keys(env).filter((name) => {
    if (deny.has(name)) return true;
    if (!allow) return false;
    if (allow.has(name)) return false;
    return !ALWAYS_KEEP.some((re) => re.test(name));
  });
}

/**
 * Wraps a sandbox provider so the spawned box doesn't inherit filtered env
 * vars. execRunner always spreads `process.env` into the child, so we can't
 * drop vars from the spawn env. Instead the command is prefixed with
 * `env -u NAME ...`, which removes them before exec'ing the real command (or
 * the sandbox wrapper, which then passes the cleaned env through).
 *
 * `env -u` rather than `env -i K=V`: values never appear in argv (visible in
 * `ps`), only names do.
 *
 * POSIX only. On Windows the policy can't be applied; we warn once and run
 * unfiltered.
 */
export function withEnvPolicy(
  inner: SandboxProvider,
  policy: EnvPolicy
): SandboxProvider {
  return {
    name: `${inner.name}+env`,
    platforms: inner.platforms,
    prepare(spec: SpawnSpec, reflect: ReflectHost): PreparedSpawn {
      const prepared = inner.prepare(spec, reflect);
      const unset = varsToUnset(policy);
      if (unset.length === 0) return prepared;
      if (process.platform === 'win32') {
        warnOnce(
          'box env filtering is not supported on Windows; the box inherits ' +
            'the full environment.'
        );
        return prepared;
      }
      return {
        ...prepared,
        cmd: 'env',
        args: [
          ...unset.flatMap((name) => ['-u', name]),
          prepared.cmd,
          ...prepared.args,
        ],
      };
    },
  };
}

let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[genkit-channels] ${message}`);
}
