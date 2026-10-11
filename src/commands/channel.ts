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
 * Channel management commands: install and manage channels fetched from a source
 * repo or local path into `.genkit/channels/`.
 *
 * Exposed as top-level commands: `genkit-channel add|list|remove|update`.
 */

import { Command } from 'commander';
import fs from 'fs';
import { runChannelBuild } from '../core/channels/build';
import { fetchSource, parseSource } from '../core/channels/fetch';
import { installChannels, readChannelLock } from '../core/channels/install';
import {
  channelDir,
  channelsRoot,
  listInstalledChannels,
  loadChannel,
} from '../core/channels/loader';
import { logger } from '../util/logger';
import { confirm, isInteractive } from '../util/prompt';
import { findProjectRoot } from '../util/project-root';

interface AddOptions {
  ref?: string;
  dir?: string;
  force?: boolean;
  build?: boolean;
  yes?: boolean;
}

/**
 * Runs the install-time build for any freshly installed channels that declare a
 * `build` in their `channel.yaml` (e.g. a TypeScript channel that compiles to
 * `dist/`). The user is asked to confirm before anything runs.
 *
 * Behavior:
 *  - `--build` / `--yes` runs the build without asking (good for CI).
 *  - `--no-build` skips it entirely.
 *  - otherwise, prompt per channel (and, when non-interactive with no flag, skip
 *    with a hint on how to build later).
 */
async function maybeBuildChannels(
  projectRoot: string,
  names: string[],
  opts: { build?: boolean; yes?: boolean }
): Promise<void> {
  for (const name of names) {
    let def;
    try {
      def = loadChannel(projectRoot, name);
    } catch {
      continue; // not loadable; nothing to build
    }
    if (!def.build) continue;

    // Explicit opt-out.
    if (opts.build === false) {
      logger.info(
        `Channel "${name}" declares a build; skipped (--no-build). ` +
          `Build it later with: cd ${channelDir(projectRoot, name)} && ${def.build}`
      );
      continue;
    }

    const auto = opts.build === true || opts.yes === true;
    let run = auto;
    if (!auto) {
      if (!isInteractive()) {
        logger.info(
          `Channel "${name}" declares a build step: ${def.build}\n` +
            `Not running it (no TTY). Re-run with --build, or build later with:\n` +
            `  cd ${channelDir(projectRoot, name)} && ${def.build}`
        );
        continue;
      }
      run = await confirm(
        `Channel "${name}" declares a build step:\n  ${def.build}\nRun it now?`,
        { defaultYes: true }
      );
    }

    if (!run) {
      logger.info(
        `Skipped build for "${name}". Build it later with:\n` +
          `  cd ${channelDir(projectRoot, name)} && ${def.build}`
      );
      continue;
    }

    runChannelBuild(projectRoot, name, { build: def.build });
    logger.info(`Built channel "${name}".`);
  }
}


export const add = new Command('add')
  .description('install channels from a source (owner/repo, URL, or local path)')
  .argument('<source>', 'channel source: owner/repo, GitHub URL, or local path')
  .argument('[name]', 'install only this channel (default: all in the source)')
  .option('--ref <ref>', 'branch, tag, or commit (or use source#ref)')
  .option('--dir <subdir>', 'subdirectory in the source that holds channels')
  .option('--force', 'overwrite an already-installed channel', false)
  .option(
    '--build',
    'run a channel\'s declared build step without asking (e.g. for CI)'
  )
  .option('--no-build', 'skip a channel\'s declared build step')
  .option('-y, --yes', 'assume yes to prompts (runs declared build steps)')
  .action(
    async (source: string, name: string | undefined, options: AddOptions) => {

      const projectRoot = await findProjectRoot();
      const parsed = parseSource(source, { ref: options.ref, dir: options.dir });

      let fetched;
      try {
        fetched = await fetchSource(parsed);
      } catch (e: any) {
        logger.error(e.message);
        process.exitCode = 1;
        return;
      }

      try {
        const installed = installChannels(
          projectRoot,
          fetched.rootDir,
          parsed,
          fetched.resolvedRef,
          name,
          { force: options.force }
        );
        if (installed.length === 0) {
          logger.info('No channels installed.');
          return;
        }
        logger.info(
          `Installed ${installed.length} channel${installed.length > 1 ? 's' : ''}: ` +
            installed.join(', ')
        );
        logger.info(`Location: ${channelsRoot(projectRoot)}`);
        logger.info(
          'Commit .genkit/channels/ so deploys work in CI and fresh checkouts.'
        );

        await maybeBuildChannels(projectRoot, installed, {
          build: options.build,
          yes: options.yes,
        });
      } catch (e: any) {
        logger.error(e.message);
        process.exitCode = 1;
      } finally {
        fetched.cleanup();
      }
    }
  );


export const list = new Command('list')
  .description('list installed channels')
  .action(async () => {
    const projectRoot = await findProjectRoot();
    const names = listInstalledChannels(projectRoot);
    if (names.length === 0) {
      logger.info(
        `No channels installed in ${channelsRoot(projectRoot)}. ` +
          `Add one with: genkit-channel add <source>`
      );
      return;
    }
    logger.info(`Channels in ${channelsRoot(projectRoot)}:`);
    for (const name of names) {
      const lock = readChannelLock(projectRoot, name);
      const from = lock
        ? ` (from ${lock.source}${lock.resolvedRef ? `@${lock.resolvedRef}` : ''})`
        : '';
      logger.info(`- ${name}${from}`);
    }
  });

export const remove = new Command('remove')
  .description('remove an installed channel')
  .argument('<name>', 'channel name to remove')
  .action(async (name: string) => {
    const projectRoot = await findProjectRoot();
    const dir = channelDir(projectRoot, name);
    if (!fs.existsSync(dir)) {
      logger.error(`Channel "${name}" is not installed.`);
      process.exitCode = 1;
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info(`Removed channel "${name}".`);
  });

export const update = new Command('update')
  .description('re-fetch installed channels using their recorded source')
  .argument('[name]', 'channel to update (default: all)')
  .option(
    '--build',
    'run a channel\'s declared build step without asking (e.g. for CI)'
  )
  .option('--no-build', 'skip a channel\'s declared build step')
  .option('-y, --yes', 'assume yes to prompts (runs declared build steps)')
  .action(async (name: string | undefined, options: AddOptions) => {
    const projectRoot = await findProjectRoot();

    const names = name ? [name] : listInstalledChannels(projectRoot);
    if (names.length === 0) {
      logger.info('No channels to update.');
      return;
    }

    for (const c of names) {
      const lock = readChannelLock(projectRoot, c);
      if (!lock) {
        logger.warn(`Channel "${c}" has no lock file; skipping.`);
        continue;
      }
      const parsed = parseSource(lock.source, {
        ref: lock.ref,
        dir: lock.subdir,
      });
      let fetched;
      try {
        fetched = await fetchSource(parsed);
      } catch (e: any) {
        logger.error(`Failed to update "${c}": ${e.message}`);
        process.exitCode = 1;
        continue;
      }
      try {
        installChannels(
          projectRoot,
          fetched.rootDir,
          parsed,
          fetched.resolvedRef,
          c,
          { force: true }
        );
        logger.info(`Updated channel "${c}".`);
        await maybeBuildChannels(projectRoot, [c], {
          build: options.build,
          yes: options.yes,
        });
      } catch (e: any) {
        logger.error(`Failed to update "${c}": ${e.message}`);
        process.exitCode = 1;
      } finally {
        fetched.cleanup();
      }
    }
  });

