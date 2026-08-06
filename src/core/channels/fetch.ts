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
 * Fetches channel sources into a local staging directory the installer can read
 * from. Supports GitHub repos (via zipball, no `git` dependency) and local
 * paths (great for developing channels).
 */

import axios from 'axios';
import extract from 'extract-zip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../../util/logger';

export type SourceKind = 'github' | 'local';

/** A parsed channel source specifier. */
export interface ParsedSource {
  kind: SourceKind;
  /** GitHub: "owner/repo". Local: absolute path. */
  location: string;
  /** Branch, tag, or sha (GitHub only). */
  ref?: string;
  /** Subdirectory within the source that holds the channels. */
  subdir?: string;
  /** The original, user-provided source string (for lock files/messages). */
  raw: string;
}

/** Result of fetching a source: a local dir the installer copies from. */
export interface FetchedSource {
  /** Directory containing channel folders (already narrowed to `subdir`). */
  rootDir: string;
  /** The resolved ref (GitHub), if any. */
  resolvedRef?: string;
  /** Cleanup callback to remove any temp files. */
  cleanup(): void;
}

/**
 * Parses a source string into a structured spec.
 *
 * Supported forms:
 *  - `owner/repo`                         (GitHub, default branch)
 *  - `owner/repo#ref`                     (GitHub at ref)
 *  - `https://github.com/owner/repo`
 *  - `https://github.com/owner/repo/tree/<ref>/<subdir>`
 *  - `file:///abs/path` or a local path   (copied directly)
 */
export function parseSource(
  source: string,
  opts: { ref?: string; dir?: string } = {}
): ParsedSource {
  const raw = source;

  // Local file path.
  if (
    source.startsWith('file://') ||
    source.startsWith('.') ||
    source.startsWith('/')
  ) {
    const location = source.startsWith('file://')
      ? new URL(source).pathname
      : path.resolve(source);
    return {
      kind: 'local',
      location,
      subdir: opts.dir,
      raw,
    };
  }

  // Split off an explicit `#ref` suffix (applies to GitHub forms).
  let ref = opts.ref;
  let rest = source;
  const hashIdx = source.indexOf('#');
  if (hashIdx !== -1) {
    rest = source.slice(0, hashIdx);
    ref = source.slice(hashIdx + 1) || ref;
  }

  // Full GitHub URL, possibly with /tree/<ref>/<subdir>.
  if (
    rest.startsWith('https://github.com/') ||
    rest.startsWith('http://github.com/')
  ) {
    const u = new URL(rest);
    const parts = u.pathname.replace(/^\/+/, '').split('/');
    const owner = parts[0];
    const repo = (parts[1] ?? '').replace(/\.git$/, '');
    let subdir = opts.dir;
    if (parts[2] === 'tree' && parts[3]) {
      ref = ref ?? parts[3];
      if (parts.length > 4) subdir = subdir ?? parts.slice(4).join('/');
    }
    if (!owner || !repo) {
      throw new Error(`Could not parse GitHub URL: ${source}`);
    }
    return { kind: 'github', location: `${owner}/${repo}`, ref, subdir, raw };
  }

  // Shorthand owner/repo.
  const shorthand = rest.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand) {
    return {
      kind: 'github',
      location: `${shorthand[1]}/${shorthand[2].replace(/\.git$/, '')}`,
      ref,
      subdir: opts.dir,
      raw,
    };
  }

  throw new Error(
    `Unrecognized channel source: "${source}". Use "owner/repo", a ` +
      `GitHub URL, or a local path.`
  );
}

/** Fetches the source into a local, readable directory. */
export async function fetchSource(parsed: ParsedSource): Promise<FetchedSource> {
  if (parsed.kind === 'local') {
    if (!fs.existsSync(parsed.location)) {
      throw new Error(`Local source path does not exist: ${parsed.location}`);
    }
    const rootDir = parsed.subdir
      ? path.join(parsed.location, parsed.subdir)
      : parsed.location;
    if (!fs.existsSync(rootDir)) {
      throw new Error(
        `Subdirectory "${parsed.subdir}" not found in ${parsed.location}.`
      );
    }
    return { rootDir, cleanup: () => {} };
  }

  return fetchGithub(parsed);
}

async function fetchGithub(parsed: ParsedSource): Promise<FetchedSource> {
  const [owner, repo] = parsed.location.split('/');
  const refsToTry = parsed.ref
    ? [parsed.ref]
    : ['main', 'master']; // default-branch guess without an API call

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genkit-channels-'));
  const zipPath = path.join(tmpRoot, 'src.zip');

  let usedRef: string | undefined;
  let lastErr: unknown;
  for (const ref of refsToTry) {
    const url = `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(
      ref
    )}`;
    try {
      logger.debug(`Fetching channel source: ${url}`);
      const resp = await axios.get(url, { responseType: 'arraybuffer' });
      fs.writeFileSync(zipPath, Buffer.from(resp.data));
      usedRef = ref;
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!usedRef) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    const tried = refsToTry.join(', ');
    throw new Error(
      `Failed to download ${owner}/${repo} (tried refs: ${tried}). ` +
        `Specify a ref with --ref if the default branch differs. ` +
        `Cause: ${(lastErr as any)?.message ?? lastErr}`
    );
  }

  const extractDir = path.join(tmpRoot, 'extracted');
  await extract(zipPath, { dir: extractDir });

  // Zipballs contain a single top-level dir: `<repo>-<ref>/...`.
  const entries = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());
  if (entries.length !== 1) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw new Error(`Unexpected zipball layout for ${owner}/${repo}.`);
  }
  let rootDir = path.join(extractDir, entries[0].name);
  if (parsed.subdir) {
    rootDir = path.join(rootDir, parsed.subdir);
    if (!fs.existsSync(rootDir)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      throw new Error(
        `Subdirectory "${parsed.subdir}" not found in ${owner}/${repo}@${usedRef}.`
      );
    }
  }

  return {
    rootDir,
    resolvedRef: usedRef,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
  };
}
