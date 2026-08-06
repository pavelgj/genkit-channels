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
 * Finds the project root by walking up from a starting directory looking for a
 * marker file. Standalone reimplementation so this package does not depend on
 * the genkit monorepo's tools-common utilities.
 */

import fs from 'fs';
import path from 'path';

const MARKERS = [
  'channels.yaml',
  'package.json',
  'go.mod',
  'pyproject.toml',
  '.git',
];

/**
 * Walks up from `startDir` (default cwd) until it finds a directory containing a
 * known project marker. Falls back to the start directory if none is found.
 */
export async function findProjectRoot(startDir = process.cwd()): Promise<string> {
  let dir = path.resolve(startDir);
  // Prefer a channels.yaml if one exists on the way up.
  let firstMarker: string | null = null;
  while (true) {
    for (const marker of MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) {
        if (marker === 'channels.yaml') return dir;
        if (!firstMarker) firstMarker = dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return firstMarker ?? path.resolve(startDir);
}
