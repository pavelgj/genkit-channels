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
 * Loads and validates an installed channel definition from
 * `.genkit/channels/<name>/channel.yaml`. Channels are Node programs.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'genkit';
import * as YAML from 'yaml';
import { formatZodError } from '../../lib/config';
import { SecretNameSchema } from '../secrets';
import { parseServiceSettings } from '../service-settings';
import type {
  ChannelDefinition,
  ChannelLanguage,
  ChannelRule,
} from '../types';


// Node only for now. A Go channel comes back as a clean port once there is a
// Go genkit-in-a-box.
const KNOWN_CHANNEL_LANGUAGES: ChannelLanguage[] = ['node'];


export const CHANNEL_MANIFEST_FILENAME = 'channel.yaml';

/** Directory where channels are installed within a project. */
export function channelsRoot(projectDir: string): string {
  return path.join(projectDir, '.genkit', 'channels');
}

/** Directory for a single installed channel. */
export function channelDir(projectDir: string, name: string): string {
  return path.join(channelsRoot(projectDir), name);
}

/** Lists the names of all installed channels. */
export function listInstalledChannels(projectDir: string): string[] {
  const root = channelsRoot(projectDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Loads a channel definition. Throws with an actionable message if the channel
 * is not installed or the manifest is malformed.
 */
export function loadChannel(
  projectDir: string,
  name: string
): ChannelDefinition {
  const dir = channelDir(projectDir, name);
  const manifestPath = path.join(dir, CHANNEL_MANIFEST_FILENAME);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Channel "${name}" is not installed. Install it with:\n` +
        `  genkit-channel add <source> ${name}`
    );
  }

  let parsed: any;
  try {
    parsed = YAML.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e: any) {
    throw new Error(
      `Failed to parse ${path.relative(projectDir, manifestPath)}: ${e.message}`
    );
  }

  return validateDefinition(parsed, dir, name, manifestPath);
}

function validateDefinition(
  parsed: any,
  dir: string,
  fallbackName: string,
  manifestPath: string
): ChannelDefinition {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${manifestPath}: channel manifest must be a YAML object.`);
  }

  const name = typeof parsed.name === 'string' ? parsed.name : fallbackName;

  const language: ChannelLanguage = parsed.language ?? 'node';
  if (!KNOWN_CHANNEL_LANGUAGES.includes(language)) {
    throw new Error(
      `${manifestPath}: "language" must be one of: ` +
        `${KNOWN_CHANNEL_LANGUAGES.join(', ')} (got "${parsed.language}").`
    );
  }

  if (!parsed.entry || typeof parsed.entry !== 'string') {
    throw new Error(`${manifestPath}: "entry" is required.`);
  }

  // A plain channel's entry is source that must be present. With a `build`
  // (e.g. TypeScript), the entry is the compiled output, which may
  // legitimately be absent until the build runs.
  if (!parsed.build) {
    const entryPath = path.join(dir, parsed.entry);
    if (!fs.existsSync(entryPath)) {
      throw new Error(
        `${manifestPath}: entry "${parsed.entry}" does not exist in the ` +
          `channel. Declare a "build" that produces it, or ship the entry.`
      );
    }
  }

  if (parsed.build !== undefined && typeof parsed.build !== 'string') {
    throw new Error(`${manifestPath}: "build" must be a string.`);
  }
  if (parsed.image !== undefined && typeof parsed.image !== 'string') {
    throw new Error(`${manifestPath}: "image" must be a string.`);
  }

  const validate = parseRules(parsed.validate, 'validate', manifestPath);
  const warn = parseRules(parsed.warn, 'warn', manifestPath);
  const env = Array.isArray(parsed.env) ? parsed.env : undefined;
  const secretsParsed = z
    .array(SecretNameSchema)
    .optional()
    .safeParse(parsed.secrets);
  if (!secretsParsed.success) {
    throw new Error(
      formatZodError(secretsParsed.error, `${manifestPath}: secrets`)
    );
  }
  const secrets = secretsParsed.data;

  const recommends = parseRecommends(parsed.recommends, manifestPath);

  return {
    name,
    description: parsed.description,
    version: parsed.version,
    language,
    entry: parsed.entry,
    build: parsed.build,
    image: parsed.image,
    env,
    secrets,
    validate,
    warn,
    recommends,
    dir,
  };
}

/**
 * Parses the optional `recommends` block. Currently only `recommends.service`
 * (default service settings the channel suggests) is supported.
 */
function parseRecommends(
  raw: any,
  manifestPath: string
): ChannelDefinition['recommends'] {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${manifestPath}: "recommends" must be an object.`);
  }
  const service = parseServiceSettings(
    raw.service,
    `${manifestPath}: recommends.service`
  );
  return service ? { service } : {};
}



/** Parses an array of JSONata rules from the manifest. */
function parseRules(
  raw: any,
  field: string,
  manifestPath: string
): ChannelRule[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${manifestPath}: "${field}" must be an array.`);
  }
  return raw.map((r: any, i: number) => {
    if (!r || typeof r.expr !== 'string') {
      throw new Error(`${manifestPath}: ${field}[${i}].expr is required.`);
    }
    return {
      expr: r.expr,
      message: r.message ?? `${field} rule triggered: ${r.expr}`,
    };
  });
}
