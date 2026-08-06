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
 * Minimal interactive prompt helper. Standalone so we avoid pulling in a
 * heavier dependency (inquirer et al) for the one yes/no question we ask.
 */

import readline from 'readline';

/** True when we have a TTY to ask a question on. */
export function isInteractive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/**
 * Asks a yes/no question and resolves to the answer. When there is no TTY (CI,
 * piped input) it does not block: it returns `defaultYes` immediately.
 */
export async function confirm(
  question: string,
  opts: { defaultYes?: boolean } = {}
): Promise<boolean> {
  const defaultYes = opts.defaultYes ?? false;
  if (!isInteractive()) {
    return defaultYes;
  }

  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question(question + suffix, resolve);
    });
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === '') return defaultYes;
    return trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}
