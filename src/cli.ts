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

import { Command, program } from 'commander';
import { add, list, remove, update } from './commands/channel';
import { deploy } from './commands/deploy';
import { logger } from './util/logger';
import { version } from './version';

const commands: Command[] = [add, list, remove, update, deploy];

/** Main entry point for the genkit-channels CLI. */
export async function startCLI(): Promise<void> {
  program
    .name('genkit-channels')
    .description(
      'Experimental CLI for exposing a Genkit app over a transport (a "channel")'
    )
    .version(version);

  for (const command of commands) program.addCommand(command);

  program.addCommand(
    new Command('help').action(() => {
      logger.info(program.helpInformation());
    })
  );

  program.on('command:*', (operands) => {
    logger.error(`error: unknown command '${operands[0]}'`);
    logger.info(program.helpInformation());
    process.exit(1);
  });

  await program.parseAsync();
}
