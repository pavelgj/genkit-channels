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
 * Loads and validates channels.yaml (the user's channel configuration).
 *
 * Channel-specific validation lives in each channel's `channel.yaml` manifest
 * (JSONata rules), so this file only validates structure. The channel name is a
 * free-form string that must resolve to an installed channel at deploy time.
 * The `box` block is validated against the same schema `initChannel` uses.
 */

import fs from 'fs';
import { z } from 'genkit';
import path from 'path';
import * as YAML from 'yaml';
import {
  AgentStateSchema,
  BoxConfigSchema,
  ContextProviderConfigSchema,
  formatZodError,
} from '../lib/config';
import { DeploymentSecretsSchema, SecretNameSchema } from './secrets';
import { parseServiceSettings } from './service-settings';
import { isKnownTarget, knownTargets } from './targets';
import type {
  AgentDirConfig,
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

export interface SelectDeploymentsOptions {
  /** Select every deployment (the caller's `--all`). */
  all?: boolean;
  /** Whether the caller offers `--all`; only affects the error hint. */
  allowAll?: boolean;
}

/**
 * Picks deployments by name. With no name, a single-deployment manifest picks
 * that one. Returns (not throws) the error so callers control how it is
 * reported.
 */
export function selectDeployments(
  deployments: DeploymentManifest[],
  name: string | undefined,
  { all = false, allowAll = false }: SelectDeploymentsOptions = {}
): DeploymentManifest[] | Error {
  if (all) return deployments;
  if (!name) {
    if (deployments.length === 1) return deployments;
    return new Error(
      `Multiple deployments defined. Specify a name` +
        `${allowAll ? ' or use --all' : ''}. ` +
        `Available: ${deployments.map((d) => d.name).join(', ')}`
    );
  }
  const match = deployments.find((d) => d.name === name);
  if (!match) {
    return new Error(
      `No deployment named "${name}". ` +
        `Available: ${deployments.map((d) => d.name).join(', ')}`
    );
  }
  return [match];
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
  const agents = validateAgents(d.agents, where);

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
  const agentState = parseOrThrow(
    z.record(AgentStateSchema).optional(),
    expose.agentState,
    `${where}.expose.agentState`
  );
  const contextProvider = parseOrThrow(
    ContextProviderConfigSchema.optional(),
    expose.contextProvider,
    `${where}.expose.contextProvider`
  );
  const box = parseOrThrow(
    BoxConfigSchema.optional(),
    d.box,
    `${where}.box`
  );
  const secrets = parseOrThrow(
    DeploymentSecretsSchema.optional(),
    d.secrets,
    `${where}.secrets`
  );
  const env = parseOrThrow(
    z.array(SecretNameSchema).optional(),
    d.env,
    `${where}.env`
  );

  return {
    name: d.name,
    channel: d.channel,
    runtime,
    agents,
    expose: {
      agent: expose.agent,
      agents: expose.agents,
      flows: expose.flows,
      agentState,
      contextProvider,
    },
    box,

    target: d.target,
    packaging: d.packaging,
    region: d.region,
    env,
    secrets,
    serviceName: d.serviceName,
    imageRepo: d.imageRepo,
    service,
    with: d.with,
  };
}



function validateRuntime(r: any, where: string): RuntimeConfig | undefined {
  // Runtime is optional: with no runtime the framework runs the built-in
  // agent-dir runtime (see `agents`).
  if (r === undefined || r === null) return undefined;
  if (typeof r !== 'object') {
    throw new Error(`${where}.runtime must be an object (e.g. { language: go }).`);
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

/**
 * Validates the optional `agents` block that configures the built-in agent-dir
 * runtime. Returns undefined when absent.
 */
function validateAgents(a: any, where: string): AgentDirConfig | undefined {
  if (a === undefined || a === null) return undefined;
  if (typeof a !== 'object') {
    throw new Error(
      `${where}.agents must be an object (e.g. { dir: ./agents }).`
    );
  }
  if (a.dir !== undefined && typeof a.dir !== 'string') {
    throw new Error(`${where}.agents.dir must be a string.`);
  }
  if (a.model !== undefined && typeof a.model !== 'string') {
    throw new Error(`${where}.agents.model must be a string.`);
  }
  return { dir: a.dir, model: a.model };
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

/** Validates `value` with `schema`, throwing a readable, located error. */
function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  where: string
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(formatZodError(parsed.error, where));
  return parsed.data;
}
