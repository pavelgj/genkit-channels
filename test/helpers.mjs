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

/** Shared bits for the test scripts. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The fake reflection runtime, as a box exec `cmd`. */
export const fakeRuntimeCmd = ['node', path.join(here, 'fake-runtime.mjs')];

let failures = 0;

export function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

/** Exits non-zero if any check failed. */
export function finish(suite) {
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${suite} checks passed.`);
  process.exit(0);
}

/** Runs `main`, reporting a crash as a failure. */
export function run(suite, main) {
  main()
    .then(() => finish(suite))
    .catch((e) => {
      console.error(`${suite} test crashed:`, e);
      process.exit(1);
    });
}

/** Concatenates the text of a turn's stream. */
export async function drain(turn) {
  let streamed = '';
  for await (const chunk of turn.stream) streamed += chunk.text ?? '';
  return streamed;
}
