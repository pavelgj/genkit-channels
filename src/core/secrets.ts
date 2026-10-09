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
 * Secrets: env vars whose values never pass through the CLI on a cloud deploy.
 *
 * Declared in two places:
 *  - `channel.yaml` `secrets: [DISCORD_TOKEN]`: what the channel needs. These go
 *    to the channel process only.
 *  - `channels.yaml` deployment `secrets`: what the app needs (a list of names),
 *    plus optional references for any secret whose platform name differs
 *    (`{ GEMINI_API_KEY: gemini-key@3 }`). Listed names go to the app only.
 *
 * Locally, values come from `.env` files (see {@link dotenvFiles}) with the
 * shell winning. On deploy, targets turn each secret's `ref` into a platform
 * reference (Cloud Run: Secret Manager) and check that it exists; they never
 * create secrets.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'genkit';

/** An env var name, which is also the default secret name on the platform. */
export const SecretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'expected an env var name like API_KEY');

/**
 * A deployment's `secrets`: a list of names, or a map from name to a
 * platform reference (a string the target interprets; `null`/empty means "same
 * as the name").
 */
export const DeploymentSecretsSchema = z.union([
  z.array(SecretNameSchema),
  z.record(SecretNameSchema, z.string().min(1).nullable()),
]);
export type DeploymentSecrets = z.infer<typeof DeploymentSecretsSchema>;

/** Which process receives a secret. */
export type SecretConsumer = 'channel' | 'app';

export interface ResolvedSecret {
  /** Env var name the code reads. */
  name: string;
  consumer: SecretConsumer;
  /**
   * Platform-neutral reference, interpreted by the deploy target. Defaults to
   * `name` (Cloud Run: the Secret Manager secret of that name, latest version).
   */
  ref: string;
  /** For messages: `channel discord` or `app`. */
  declaredBy: string;
}

/**
 * Combines the channel's declared secrets with the deployment's. A deployment
 * entry naming a channel secret only overrides its reference; it stays the
 * channel's.
 */
export function resolveSecrets(opts: {
  channelName: string;
  channelSecrets: readonly string[];
  deploymentSecrets: DeploymentSecrets | undefined;
}): ResolvedSecret[] {
  const { channelName, channelSecrets, deploymentSecrets } = opts;
  const refs: Record<string, string | null> = Array.isArray(deploymentSecrets)
    ? Object.fromEntries(deploymentSecrets.map((n) => [n, null]))
    : (deploymentSecrets ?? {});
  const out: ResolvedSecret[] = [];
  const seen = new Set<string>();
  const add = (name: string, consumer: SecretConsumer) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({
      name,
      consumer,
      ref: refs[name] || name,
      declaredBy: consumer === 'channel' ? `channel ${channelName}` : 'app',
    });
  };
  for (const name of channelSecrets) add(name, 'channel');
  for (const name of Object.keys(refs)) add(name, 'app');
  return out;
}

/**
 * The `.env` files read for a local run, lowest precedence first. Same
 * convention as Vite/Next: commit `.env` (defaults), keep real values in the
 * gitignored `*.local` files.
 */
export function dotenvFiles(deploymentName: string): string[] {
  return [
    '.env',
    '.env.local',
    `.env.${deploymentName}`,
    `.env.${deploymentName}.local`,
  ];
}

/**
 * Loads the `.env` files for `deploymentName` from `projectDir`. Vars already
 * in `shell` win over every file, so CI, direnv and one-off overrides work.
 * Returns only what the files contributed (callers merge with the shell).
 */
export function loadDotenv(
  projectDir: string,
  deploymentName: string,
  shell: NodeJS.ProcessEnv = process.env
): { values: Record<string, string>; files: string[] } {
  const merged: Record<string, string> = {};
  const files: string[] = [];
  for (const file of dotenvFiles(deploymentName)) {
    const p = path.join(projectDir, file);
    if (!fs.existsSync(p)) continue;
    Object.assign(merged, parseEnv(fs.readFileSync(p, 'utf8')));
    files.push(file);
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (shell[name] === undefined) values[name] = value;
  }
  return { values, files };
}

/** Secrets with no (or an empty) value in `env`. */
export function missingSecrets(
  secrets: readonly ResolvedSecret[],
  env: NodeJS.ProcessEnv
): ResolvedSecret[] {
  return secrets.filter((s) => !env[s.name]);
}

/** Lines like `  DISCORD_TOKEN   (channel discord)`, aligned. */
export function formatSecretList(secrets: readonly ResolvedSecret[]): string {
  const width = Math.max(...secrets.map((s) => s.name.length));
  return secrets
    .map((s) => `  ${s.name.padEnd(width)}  (${s.declaredBy})`)
    .join('\n');
}

const SECRET_LIKE = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;

/** Env var names that look like they should be `secrets` instead. */
export function secretLikeNames(names: readonly string[]): string[] {
  return names.filter((n) => SECRET_LIKE.test(n));
}
