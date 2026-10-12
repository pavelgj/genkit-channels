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
 * Compiles the Slack/Discord-free parts of the TypeScript channels (bridge,
 * turn) for the unit tests, into `test/.build/<channel>/`.
 *
 * Deliberately not into the channel's own `dist/`: a partial `dist/` there
 * (say, bridge.js without index.js) gets copied by `genkit-channel add` and
 * looks like a finished build. Channel `dist/` is only ever written by the
 * channel's real build.
 *
 *   node test/build-channel-units.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, '.build');
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');

const units = {
  discord: ['bridge.ts'],
  'slack-socket': ['bridge.ts', 'turn.ts'],
};

fs.rmSync(out, { recursive: true, force: true });
for (const [channel, files] of Object.entries(units)) {
  const src = path.join(root, 'channels', channel, 'src');
  const outDir = path.join(out, channel);
  fs.mkdirSync(outDir, { recursive: true });
  // A throwaway tsconfig: `paths` (turn.ts imports types from the library,
  // resolved to the local build) has no command-line equivalent.
  const tsconfig = path.join(outDir, 'tsconfig.json');
  fs.writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2021',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        rootDir: src,
        outDir,
        paths: { 'genkit-channels': [path.join(root, 'dist', 'index.d.ts')] },
      },
      files: files.map((f) => path.join(src, f)),
    })
  );
  execFileSync(tsc, ['-p', tsconfig], { stdio: 'inherit' });
}
// The channels are ESM; the repo root is CommonJS.
fs.writeFileSync(path.join(out, 'package.json'), '{ "type": "module" }\n');
// Runtime imports of `genkit-channels` (turn.ts uses isAuthError) resolve to
// this checkout, as `linkLocalLibrary` arranges for a real channel install.
fs.mkdirSync(path.join(out, 'node_modules'), { recursive: true });
fs.symlinkSync(root, path.join(out, 'node_modules', 'genkit-channels'), 'dir');
