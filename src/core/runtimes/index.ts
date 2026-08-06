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
 * Per-language runtime builders. Each turns a manifest `runtime` block into a
 * resolved child command plus the pieces needed to build a Docker image. This
 * is the only language-aware part of genkit-channels; channels stay language
 * agnostic.
 */

import type { ResolvedRuntime, RuntimeConfig, RuntimeLanguage } from '../types';
import { goRuntime } from './go';
import { jsRuntime } from './js';
import { pythonRuntime } from './python';

export interface RuntimeBuilder {
  language: RuntimeLanguage;
  /** Resolve a manifest runtime block into a concrete build/run plan. */
  resolve(runtime: RuntimeConfig): ResolvedRuntime;
}

const BUILDERS: Record<RuntimeLanguage, RuntimeBuilder> = {
  go: goRuntime,
  js: jsRuntime,
  python: pythonRuntime,
};

/** Returns the runtime builder for a language, or throws. */
export function getRuntimeBuilder(language: RuntimeLanguage): RuntimeBuilder {
  const b = BUILDERS[language];
  if (!b) {
    throw new Error(
      `No runtime builder for language "${language}". ` +
        `Supported: ${Object.keys(BUILDERS).join(', ')}.`
    );
  }
  return b;
}
