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
 * Installs channels from a fetched source directory into a project's
 * `.genkit/channels/` folder, recording provenance in a lock file per channel.
 */

import fs from 'fs';
import path from 'path';
import * as YAML from 'yaml';
import { logger } from '../../util/logger';
import { channelDir, channelsRoot } from './loader';
import type { ParsedSource } from './fetch';

export const CHANNEL_LOCK_FILENAME = '.channel-lock.json';

/** Provenance recorded alongside each installed channel. */
export interface ChannelLock {
  source: string;
  kind: string;
  ref?: string;
  resolvedRef?: string;
  subdir?: string;
  installedAt: string;
}

export interface InstallOptions {
  force?: boolean;
}

/**
 * Copies channels from `sourceRootDir` into the project. If `only` is given,
 * installs just that channel; otherwise installs every channel found (a channel
 * being any subdirectory that contains a `channel.yaml`).
 */
export function installChannels(
  projectDir: string,
  sourceRootDir: string,
  parsed: ParsedSource,
  resolvedRef: string | undefined,
  only: string | undefined,
  opts: InstallOptions = {}
): string[] {
  const candidates = discoverChannels(sourceRootDir);
  if (candidates.length === 0) {
    throw new Error(
      `No channels found in source. Expected directories like ` +
        `"<name>/channel.yaml".`
    );
  }

  let toInstall = candidates;
  if (only) {
    toInstall = candidates.filter((c) => c === only);
    if (toInstall.length === 0) {
      throw new Error(
        `Channel "${only}" not found in source. Available: ${candidates.join(', ')}`
      );
    }
  }

  fs.mkdirSync(channelsRoot(projectDir), { recursive: true });

  const installed: string[] = [];
  for (const name of toInstall) {
    const destDir = channelDir(projectDir, name);
    if (fs.existsSync(destDir)) {
      if (!opts.force) {
        logger.warn(
          `Channel "${name}" already installed; skipping (use --force to overwrite).`
        );
        continue;
      }
      fs.rmSync(destDir, { recursive: true, force: true });
    }

    const srcDir = path.join(sourceRootDir, name);
    // A channel that builds gets its output from that build (run by `add`
    // after confirmation, or by the image build), never from whatever `dist/`
    // the source checkout happens to have. A stale or partial one would
    // otherwise look like a finished build.
    const skip = new Set(['node_modules', '.git']);
    if (declaresBuild(srcDir)) {
      for (const d of BUILD_OUTPUT_DIRS) skip.add(d);
    }
    copyDir(srcDir, destDir, skip);

    const lock: ChannelLock = {
      source: parsed.raw,
      kind: parsed.kind,
      ref: parsed.ref,
      resolvedRef: resolvedRef ?? parsed.ref,
      subdir: parsed.subdir,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(destDir, CHANNEL_LOCK_FILENAME),
      JSON.stringify(lock, null, 2) + '\n'
    );
    installed.push(name);
  }

  return installed;
}

/** Reads the lock file for an installed channel, if present. */
export function readChannelLock(
  projectDir: string,
  name: string
): ChannelLock | null {
  const p = path.join(channelDir(projectDir, name), CHANNEL_LOCK_FILENAME);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ChannelLock;
  } catch {
    return null;
  }
}

/**
 * Finds channel names in a source dir. A channel is a directory that contains a
 * `channel.yaml` directly.
 */
function discoverChannels(sourceRootDir: string): string[] {
  if (!fs.existsSync(sourceRootDir)) return [];
  const names: string[] = [];
  for (const entry of fs.readdirSync(sourceRootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sourceRootDir, entry.name);
    if (fs.existsSync(path.join(dir, 'channel.yaml'))) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/** Build output dirs dropped from channels that declare a `build`. */
const BUILD_OUTPUT_DIRS = ['dist'];

/**
 * Whether the channel's `channel.yaml` declares a `build`. Read loosely: a
 * malformed manifest still installs, and fails later with the loader's
 * proper error.
 */
function declaresBuild(channelSrcDir: string): boolean {
  try {
    const raw: unknown = YAML.parse(
      fs.readFileSync(path.join(channelSrcDir, 'channel.yaml'), 'utf8')
    );
    return (
      typeof raw === 'object' &&
      raw !== null &&
      'build' in raw &&
      typeof raw.build === 'string' &&
      raw.build.length > 0
    );
  } catch {
    return false;
  }
}

/** Copies `src` to `dest`, skipping top-level dirs named in `skipTop`. */
function copyDir(src: string, dest: string, skipTop: ReadonlySet<string>) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (skipTop.has(entry.name)) continue;
      copyTree(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/** Copies a whole tree, skipping only `node_modules` and `.git`. */
function copyTree(src: string, dest: string) {
  copyDir(src, dest, new Set(['node_modules', '.git']));
}
