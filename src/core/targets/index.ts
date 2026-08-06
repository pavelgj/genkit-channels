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
 * The deploy target registry. Targets are pluggable: each declares which
 * packagings it supports and owns generating + shipping its artifacts. Adding a
 * target is a matter of registering it here (no type change, since TargetName is
 * a string backed by this registry).
 */

import type { DeployTarget, TargetName } from '../types';
import { cloudRunTarget } from './cloud-run';

const TARGETS: Record<string, DeployTarget> = {
  [cloudRunTarget.name]: cloudRunTarget,
};

/** Names of all registered targets. */
export function knownTargets(): TargetName[] {
  return Object.keys(TARGETS).sort();
}

/** Whether a name resolves to a registered target. */
export function isKnownTarget(name: string): boolean {
  return name in TARGETS;
}

/** Returns the target for a name, or throws with the list of known targets. */
export function getTarget(name: TargetName): DeployTarget {
  const t = TARGETS[name];
  if (!t) {
    throw new Error(
      `Unknown target "${name}". Known targets: ${knownTargets().join(', ')}.`
    );
  }
  return t;
}
