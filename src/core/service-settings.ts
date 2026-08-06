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
 * Resolves portable service settings (access, cpu, scaling, memory) from three
 * layers, in precedence order:
 *
 *   1. user values in channels.yaml   (deployment.service)   -- final say
 *   2. channel recommendations        (channel.recommends.service)
 *   3. secure built-in defaults       (private, request-only)
 *
 * One deliberate exception: `access` is never escalated to `public` by a channel
 * recommendation alone. If a channel recommends `public` and the user did not
 * set `access`, we resolve to `private` and surface a notice so the user can opt
 * in explicitly. Everything else applies recommendations as ordinary defaults.
 *
 * The resolver is platform-neutral; targets translate the result into their own
 * knobs (Cloud Run flags / Knative annotations).
 */

import type {
  ResolvedServiceSettings,
  ServiceAccess,
  ServiceCpu,
  ServiceSettings,
} from './types';


/** Secure built-in defaults used when neither user nor channel set a value. */
const DEFAULTS = {
  access: 'private',
  cpu: 'request-only',
} as const;

/** The outcome of resolving service settings: values plus advisory notices. */
export interface ResolvedServiceSettingsResult {
  settings: ResolvedServiceSettings;
  /** Human-readable notices to log (opt-in hints, cost warnings). */
  notices: string[];
}

/**
 * Resolves the effective service settings for a deployment.
 *
 * @param userService  the deployment's `service` block (may be undefined)
 * @param channelRecommends  the channel's `recommends.service` (may be undefined)
 */
export function resolveServiceSettings(
  userService: ServiceSettings | undefined,
  channelRecommends: ServiceSettings | undefined
): ResolvedServiceSettingsResult {
  const user = userService ?? {};
  const rec = channelRecommends ?? {};
  const notices: string[] = [];

  // access: user wins; a channel `public` recommendation is a notice, not a
  // default. A channel `private` recommendation applies normally (harmless).
  let access = user.access;
  if (access === undefined) {
    if (rec.access === 'public') {
      access = 'private';
      notices.push(
        'the channel recommends public access; it stays private until you set ' +
          '`service.access: public` in channels.yaml.'
      );
    } else {
      access = rec.access ?? DEFAULTS.access;
    }
  }

  const cpu = user.cpu ?? rec.cpu ?? DEFAULTS.cpu;
  const minInstances = firstDefined(user.minInstances, rec.minInstances);
  const maxInstances = firstDefined(user.maxInstances, rec.maxInstances);
  const concurrency = firstDefined(user.concurrency, rec.concurrency);
  const memory = firstDefined(user.memory, rec.memory);

  const settings: ResolvedServiceSettings = {
    access,
    cpu,
    minInstances,
    maxInstances,
    concurrency,
    memory,
  };

  // Cost notices: always-on CPU and warm instances are billed continuously.
  if (cpu === 'always-allocated') {
    notices.push(
      'cpu is always-allocated (no CPU throttling): the instance is billed for ' +
        'CPU even when idle.'
    );
  }
  if (minInstances !== undefined && minInstances >= 1) {
    notices.push(
      `minInstances is ${minInstances}: at least one instance stays warm and ` +
        'is billed continuously.'
    );
  }

  return { settings, notices };
}

/** Returns the first argument that is not undefined. */
function firstDefined<T>(...vals: (T | undefined)[]): T | undefined {
  for (const v of vals) if (v !== undefined) return v;
  return undefined;
}

const ACCESS_VALUES: ServiceAccess[] = ['public', 'private'];
const CPU_VALUES: ServiceCpu[] = ['request-only', 'always-allocated'];

/**
 * Validates and normalizes a raw `service` block from YAML into
 * {@link ServiceSettings}. Throws with `where` context on malformed input.
 * Shared by the manifest parser and the channel loader so both accept the exact
 * same shape.
 */
export function parseServiceSettings(
  raw: any,
  where: string
): ServiceSettings | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must be an object.`);
  }

  if (raw.access !== undefined && !ACCESS_VALUES.includes(raw.access)) {
    throw new Error(
      `${where}.access must be one of: ${ACCESS_VALUES.join(', ')} ` +
        `(got "${raw.access}").`
    );
  }
  if (raw.cpu !== undefined && !CPU_VALUES.includes(raw.cpu)) {
    throw new Error(
      `${where}.cpu must be one of: ${CPU_VALUES.join(', ')} (got "${raw.cpu}").`
    );
  }

  const minInstances = parseNonNegativeInt(raw.minInstances, `${where}.minInstances`);
  const maxInstances = parseNonNegativeInt(raw.maxInstances, `${where}.maxInstances`);
  const concurrency = parsePositiveInt(raw.concurrency, `${where}.concurrency`);

  if (raw.memory !== undefined && typeof raw.memory !== 'string') {
    throw new Error(`${where}.memory must be a string (e.g. "512Mi").`);
  }

  return {
    access: raw.access,
    cpu: raw.cpu,
    minInstances,
    maxInstances,
    concurrency,
    memory: raw.memory,
  };
}

function parseNonNegativeInt(v: any, where: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`${where} must be a non-negative integer (got "${v}").`);
  }
  return v;
}

function parsePositiveInt(v: any, where: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new Error(`${where} must be a positive integer (got "${v}").`);
  }
  return v;
}

