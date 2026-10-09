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
 * Secret Manager wiring for the Cloud Run target.
 *
 * A secret's `ref` is read as a Secret Manager reference:
 *   `NAME`                                   secret NAME, latest version
 *   `NAME@3`                                 pinned version
 *   `projects/P/secrets/NAME[/versions/V]`   another project
 *
 * The CLI only reads Secret Manager (`gcloud secrets describe`). It never
 * creates or changes secrets; when some are missing it prints the commands.
 */

import { spawnSync } from 'child_process';
import {
  formatSecretList,
  type ResolvedSecret,
  type SecretConsumer,
} from '../secrets';

export interface GcpSecretRef {
  /** Set only for secrets in another project. */
  project?: string;
  secret: string;
  version: string;
}

const FULL_REF =
  /^projects\/([^/]+)\/secrets\/([^/@]+)(?:\/versions\/([^/]+))?$/;
const SHORT_REF = /^([A-Za-z0-9_-]+)(?:@([A-Za-z0-9_-]+))?$/;

/** Parses a secret `ref`; throws with the accepted forms on a bad one. */
export function parseGcpSecretRef(ref: string): GcpSecretRef {
  const full = FULL_REF.exec(ref);
  if (full) {
    return { project: full[1], secret: full[2], version: full[3] ?? 'latest' };
  }
  const short = SHORT_REF.exec(ref);
  if (short) return { secret: short[1], version: short[2] ?? 'latest' };
  throw new Error(
    `Invalid Secret Manager reference "${ref}". Use NAME, NAME@VERSION, or ` +
      `projects/PROJECT/secrets/NAME[/versions/VERSION].`
  );
}

/** `ENV=secret:version` pairs for `gcloud run deploy --set-secrets`. */
export function setSecretsFlag(secrets: readonly ResolvedSecret[]): string {
  return secrets
    .map((s) => {
      const r = parseGcpSecretRef(s.ref);
      const name = r.project
        ? `projects/${r.project}/secrets/${r.secret}`
        : r.secret;
      return `${s.name}=${name}:${r.version}`;
    })
    .join(',');
}

/**
 * Service YAML pieces for secrets: per-container `env` entries and the
 * template annotation that aliases secrets from other projects (Knative
 * `secretKeyRef.name` can't hold a resource path).
 */
export function serviceYamlSecrets(secrets: readonly ResolvedSecret[]): {
  envLines(consumer: SecretConsumer): string[];
  annotation?: string;
} {
  const aliases: string[] = [];
  const entries = secrets.map((s) => {
    const r = parseGcpSecretRef(s.ref);
    let name = r.secret;
    if (r.project) {
      name = `secret-${aliases.length}`;
      aliases.push(`${name}:projects/${r.project}/secrets/${r.secret}`);
    }
    return { secret: s, name, version: r.version };
  });
  return {
    envLines: (consumer) =>
      entries
        .filter((e) => e.secret.consumer === consumer)
        .map(
          (e) =>
            `            - name: ${e.secret.name}\n` +
            `              valueFrom:\n` +
            `                secretKeyRef:\n` +
            `                  name: ${JSON.stringify(e.name)}\n` +
            `                  key: ${JSON.stringify(e.version)}`
        ),
    annotation:
      aliases.length > 0
        ? `        run.googleapis.com/secrets: ${JSON.stringify(aliases.join(','))}`
        : undefined,
  };
}

/** Runs gcloud and returns trimmed stdout, or undefined on failure. */
export type Gcloud = (args: string[]) => string | undefined;

export const gcloud: Gcloud = (args) => {
  const r = spawnSync('gcloud', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

/**
 * Checks that every secret exists in Secret Manager. Throws with the
 * `gcloud` commands to create them (and grant access) when some don't.
 */
export function checkGcpSecrets(
  secrets: readonly ResolvedSecret[],
  run: Gcloud = gcloud
): void {
  if (secrets.length === 0) return;
  const refs = secrets.map((s) => ({ s, r: parseGcpSecretRef(s.ref) }));
  const defaultProject = run(['config', 'get-value', 'project']) || undefined;
  if (!defaultProject && refs.some(({ r }) => !r.project)) {
    throw new Error(
      'No Google Cloud project set. Run `gcloud config set project PROJECT`.'
    );
  }
  const projectOf = (r: GcpSecretRef) => r.project ?? defaultProject ?? '';

  const missing = refs.filter(
    ({ r }) =>
      run([
        'secrets',
        'describe',
        r.secret,
        `--project=${projectOf(r)}`,
        '--format=value(name)',
      ]) === undefined
  );
  if (missing.length === 0) return;

  const number = defaultProject
    ? run(['projects', 'describe', defaultProject, '--format=value(projectNumber)'])
    : undefined;
  // Cloud Run's default runtime identity; a service with its own account
  // needs the binding for that one instead.
  const member =
    `serviceAccount:${number || 'PROJECT_NUMBER'}` +
    `-compute@developer.gserviceaccount.com`;
  const create = missing.map(
    ({ s, r }) =>
      `  printf '%s' "$${s.name}" | gcloud secrets create ${r.secret} ` +
      `--data-file=- --project=${projectOf(r)}`
  );
  const grant = missing.map(
    ({ r }) =>
      `  gcloud secrets add-iam-policy-binding ${r.secret} ` +
      `--member=${member} --role=roles/secretmanager.secretAccessor ` +
      `--project=${projectOf(r)}`
  );
  const where = defaultProject ? ` (project ${defaultProject})` : '';

  throw new Error(
    `Missing Secret Manager secrets${where}:\n` +
      `${formatSecretList(missing.map(({ s }) => s))}\n\n` +
      `Create them (values from your shell; to load .env.local first, run ` +
      `\`set -a; . ./.env.local; set +a\`):\n` +
      `${create.join('\n')}\n\n` +
      `Let the service read them (default compute service account shown):\n` +
      `${grant.join('\n')}`
  );
}
