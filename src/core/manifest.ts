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
 * Loads and validates channels.yaml.
 *
 * Channel-specific validation lives in each channel's `channel.yaml` (JSONata
 * rules), so this file only validates manifest structure. The channel name is a
 * free-form string that must resolve to an installed channel at deploy time.
 */

import fs from 'fs';
import path from 'path';
import * as YAML from 'yaml';
import { parseServiceSettings } from './service-settings';
import { isKnownTarget, knownTargets } from './targets';
import type {
  DeployConfig,
  DeploymentManifest,
  PackagingName,
  RuntimeConfig,
  RuntimeLanguage,
} from './types';


export const MANIFEST_FILENAME = 'channels.yaml';

const KNOWN_LANGUAGES: RuntimeLanguage[] = ['js', 'go', 'python'];
const KNOWN_PACKAGINGS: PackagingName[] = ['single-container', 'sidecar'];


/** Returns the manifest path for a project dir, or null if none exists. */
export function findManifest(projectDir: string): string | null {
  const p = path.join(projectDir, MANIFEST_FILENAME);
  return fs.existsSync(p) ? p : null;
}

/** Loads and validates the manifest. Throws on malformed input. */
export function loadManifest(projectDir: string): DeployConfig {
  const manifestPath = findManifest(projectDir);
  if (!manifestPath) {
    throw new Error(
      `No ${MANIFEST_FILENAME} found in ${projectDir}. ` +
        `Create one to describe your channels.`
    );
  }
  const raw = fs.readFileSync(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (e: any) {
    throw new Error(`Failed to parse ${MANIFEST_FILENAME}: ${e.message}`);
  }
  return validateConfig(parsed);
}

function validateConfig(parsed: unknown): DeployConfig {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${MANIFEST_FILENAME} must be a YAML object.`);
  }
  const deployments = (parsed as any).deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error(
      `${MANIFEST_FILENAME} must have a non-empty "deployments" array.`
    );
  }
  const seen = new Set<string>();
  const validated = deployments.map((d, i) => validateDeployment(d, i, seen));
  return { deployments: validated };
}

function validateDeployment(
  d: any,
  index: number,
  seen: Set<string>
): DeploymentManifest {
  const where = `deployments[${index}]`;
  if (!d || typeof d !== 'object') {
    throw new Error(`${where} must be an object.`);
  }
  if (!d.name || typeof d.name !== 'string') {
    throw new Error(`${where}.name is required.`);
  }
  if (seen.has(d.name)) {
    throw new Error(`Duplicate deployment name "${d.name}".`);
  }
  seen.add(d.name);

  if (!d.channel || typeof d.channel !== 'string') {
    throw new Error(
      `${where}.channel is required (name of an installed channel).`
    );
  }

  const runtime = validateRuntime(d.runtime, where);

  if (d.target !== undefined && !isKnownTarget(d.target)) {
    throw new Error(
      `${where}.target must be one of: ${knownTargets().join(', ')} ` +
        `(got "${d.target}").`
    );
  }

  if (d.packaging !== undefined && !KNOWN_PACKAGINGS.includes(d.packaging)) {
    throw new Error(
      `${where}.packaging must be one of: ${KNOWN_PACKAGINGS.join(', ')} ` +
        `(got "${d.packaging}").`
    );
  }

  if (d.imageRepo !== undefined && typeof d.imageRepo !== 'string') {
    throw new Error(`${where}.imageRepo must be a string.`);
  }

  const service = parseServiceSettings(d.service, `${where}.service`);

  const expose = d.expose ?? {};

  if (typeof expose !== 'object') {
    throw new Error(`${where}.expose must be an object.`);
  }

  return {
    name: d.name,
    channel: d.channel,
    runtime,
    expose: {
      agent: expose.agent,
      agents: expose.agents,
      flows: expose.flows,
    },
    target: d.target,
    packaging: d.packaging,
    region: d.region,
    env: d.env,
    serviceName: d.serviceName,
    imageRepo: d.imageRepo,
    service,
    with: d.with,
  };
}



function validateRuntime(r: any, where: string): RuntimeConfig {
  if (!r || typeof r !== 'object') {
    throw new Error(`${where}.runtime is required (e.g. { language: go }).`);
  }
  if (!r.language || !KNOWN_LANGUAGES.includes(r.language)) {
    throw new Error(
      `${where}.runtime.language must be one of: ${KNOWN_LANGUAGES.join(', ')} ` +
        `(got "${r.language}").`
    );
  }
  return {
    language: r.language,
    build: r.build,
    command: r.command,
    args: Array.isArray(r.args) ? r.args : undefined,
    entry: r.entry,
    cwd: r.cwd,
  };
}

/** Resolves the flattened list of agent names to expose. */
export function resolveAgents(d: DeploymentManifest): string[] {
  const list = [...(d.expose?.agents ?? [])];
  if (d.expose?.agent) list.unshift(d.expose.agent);
  return dedupe(list);
}

/** Resolves the flattened list of flow names to expose. */
export function resolveFlows(d: DeploymentManifest): string[] {
  return dedupe(d.expose?.flows ?? []);
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}
