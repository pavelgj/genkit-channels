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
 * JS/Node runtime builder. Installs deps, optionally builds, and runs the app
 * headless. The user's app should register its actions and idle (not start its
 * own HTTP server); see the design doc's "headless user entry" note.
 */

import type { ResolvedRuntime, RuntimeConfig } from '../types';

const DEFAULT_BUILD = 'npm install';
const DEFAULT_ENTRY = 'lib/index.js';

export const jsRuntime = {
  language: 'js' as const,

  resolve(runtime: RuntimeConfig): ResolvedRuntime {
    const cwd = runtime.cwd ?? '.';
    const entry = runtime.entry ?? DEFAULT_ENTRY;
    const build = runtime.build ?? DEFAULT_BUILD;
    const command = runtime.command ?? 'node';
    const args = runtime.command ? (runtime.args ?? []) : [entry];
    return {
      language: 'js',
      command,
      args,
      cwd,
      build,
      dockerfile: {
        builderImage: 'node:20',

        buildSteps: [
          'WORKDIR /workspace/user',
          cwd !== '.' ? `RUN sh -c "cd ${cwd} && ${build}"` : `RUN ${build}`,
        ],
        copyArtifacts: [
          // Copy the whole user dir (includes node_modules + built output).
          { from: '/workspace/user', to: '/app/user' },
        ],
      },
    };
  },
};
