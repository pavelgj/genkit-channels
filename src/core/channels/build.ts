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
 * Runs a channel's declared `build` command in its installed directory.
 *
 * A channel written in a compiled/transpiled language (e.g. TypeScript) declares
 * a `build` in its `channel.yaml` (for example `npm install && npm run build`)
 * that produces its runnable `entry`. This runs after install, once the user has
 * confirmed it, so the installed channel is ready to run without a separate step.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../../util/logger';
import { linkLocalLibrary } from '../../util/local-library';
import { channelDir } from './loader';

export interface RunChannelBuildOptions {
  /** The `build` command to run (from channel.yaml). */
  build: string;
}

/**
 * Runs `build` in the installed channel's directory with inherited stdio, so the
 * user sees build output live. Throws on a non-zero exit.
 */
export function runChannelBuild(
  projectDir: string,
  name: string,
  opts: RunChannelBuildOptions
): void {
  const dir = channelDir(projectDir, name);

  // The bundled channels depend on the (unpublished) `genkit-channels` helper
  // library; link it locally so the channel's own `npm install` resolves it.
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    linkLocalLibrary(pkgPath);
  }

  logger.info(`Building channel "${name}": ${opts.build}`);
  const res = spawnSync(opts.build, {
    cwd: dir,
    stdio: 'inherit',
    shell: true,
  });
  if (res.error) {
    throw new Error(
      `failed to run build for channel "${name}": ${res.error.message}`
    );
  }
  if (res.status !== 0) {
    throw new Error(
      `build for channel "${name}" exited with code ${res.status}.`
    );
  }
}
