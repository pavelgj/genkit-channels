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
 * Go runtime builder. Builds the user's module into a static binary and runs it
 * headless (the app must not start its own HTTP transport; see the design doc's
 * "headless user entry" note).
 */

import type { ResolvedRuntime, RuntimeConfig } from '../types';

const DEFAULT_BUILD = 'go build -o bin/app ./...';
const DEFAULT_COMMAND = './bin/app';

export const goRuntime = {
  language: 'go' as const,

  resolve(runtime: RuntimeConfig): ResolvedRuntime {
    const build = runtime.build ?? DEFAULT_BUILD;
    const command = runtime.command ?? DEFAULT_COMMAND;
    const cwd = runtime.cwd ?? '.';
    return {
      language: 'go',
      command,
      args: runtime.args ?? [],
      cwd,
      build,
      dockerfile: {
        builderImage: 'golang:1.23',

        buildSteps: [
          // The user's module is copied under /workspace/user.
          'WORKDIR /workspace/user',
          'RUN --mount=type=cache,target=/go/pkg/mod ' +
            (cwd !== '.'
              ? `sh -c "cd ${cwd} && go mod download"`
              : 'go mod download'),
          cwd !== '.'
            ? `RUN sh -c "cd ${cwd} && CGO_ENABLED=0 ${build}"`
            : `RUN CGO_ENABLED=0 ${build}`,
        ],
        copyArtifacts: [
          // Copy the built binary into the final image alongside the channel.
          {
            from: `/workspace/user/${join(cwd, 'bin/app')}`,
            to: '/app/user/bin/app',
          },
        ],
      },
    };
  },
};

function join(a: string, b: string): string {
  if (!a || a === '.') return b;
  return `${a.replace(/\/$/, '')}/${b}`;
}
