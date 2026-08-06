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
 * Helpers for making the (as-yet unpublished) `genkit-channels` helper library
 * resolvable when building or running a channel from a local checkout.
 *
 * Bundled channels depend on `genkit-channels` for `startAppProcess` /
 * `createAgentApi`. Until it is published to npm, a channel's own `npm install`
 * (whether triggered at install-time build or `--local` run) would fail to
 * resolve that dependency. We rewrite it to a `file:` path pointing at this
 * package so npm links it locally. Once the library is published these become
 * no-ops.
 */

import fs from 'fs';
import path from 'path';

/** This package's root (the dir containing package.json and dist/). */
export function libraryRoot(): string {
  // Compiled location is <root>/dist/util/local-library.js.
  return path.resolve(__dirname, '..', '..');
}

/**
 * Rewrites a `genkit-channels` dependency in a channel's package.json to a
 * `file:` path pointing at this package, so `npm install` links it locally.
 * Does nothing if the channel has no such dependency.
 */
export function linkLocalLibrary(pkgPath: string): void {
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return;
  }
  let changed = false;
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[field];
    if (deps && deps['genkit-channels']) {
      deps['genkit-channels'] = `file:${libraryRoot()}`;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
}
