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
 * Cloud Run target. Owns artifact generation for both packagings it supports:
 *
 *  - single-container: write the shared multi-stage Dockerfile into the staging
 *    dir and ship it with `gcloud run deploy --source` (server-side buildpacks;
 *    no local Docker, no registry).
 *
 *  - sidecar: build + push two images (channel + user app) and apply a
 *    multi-container `service.yaml` with `gcloud run services replace`. The
 *    channel is the ingress container; the user app serves v1 reflection on
 *    loopback and the channel reaches it with a remote box runner. This path
 *    needs Cloud Build (or local Docker) and an Artifact Registry repo.
 *
 * Service settings (access, cpu, scaling, memory) come pre-resolved on the
 * context (user values over channel recommendations over secure defaults) and
 * are translated here into gcloud flags (single-container) or Knative
 * annotations + an IAM binding (sidecar). Nothing about access or CPU is
 * hardcoded: private + request-only is the default unless configured.
 *
 * Packaging generation lives in `core/packaging` (shared helpers); the platform
 * specific wiring (service spec, image build/push, gcloud invocation) lives
 * here, because it does not generalize across targets.
 */

import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ChannelConfigInput } from '../../lib/config';
import { renderSingleContainerDockerfile } from '../packaging/single-container';
import {
  renderChannelDockerfile,
  renderUserDockerfile,
} from '../packaging/sidecar';
import type {
  DeployTarget,
  DeployTargetContext,
  ResolvedServiceSettings,
} from '../types';
import { logger } from '../../util/logger';

/** Loopback port the app container serves v1 reflection on (sidecar). */
const REFLECTION_PORT = 3100;

export const cloudRunTarget: DeployTarget = {
  name: 'cloud-run',
  supportedPackagings: ['single-container', 'sidecar'],
  defaultPackaging: 'single-container',

  async validate(ctx: DeployTargetContext) {
    if (!ctx.execute) return; // dry-run: skip prerequisite checks
    const check = spawnSync('gcloud', ['--version'], { encoding: 'utf8' });
    if (check.status !== 0) {
      throw new Error(
        'gcloud CLI not found. Install the Google Cloud SDK to use the ' +
          'cloud-run target: https://cloud.google.com/sdk/docs/install'
      );
    }
    if (ctx.packaging === 'sidecar' && !ctx.deployment.imageRepo) {
      throw new Error(
        'sidecar packaging requires an image repository. Set ' +
          '`imageRepo` on the deployment (e.g. ' +
          'us-central1-docker.pkg.dev/PROJECT/genkit-channels).'
      );
    }
  },

  async deploy(ctx: DeployTargetContext): Promise<{ url?: string }> {
    if (ctx.packaging === 'sidecar') {
      return deploySidecar(ctx);
    }
    return deploySingleContainer(ctx);
  },
};

/** single-container: Dockerfile + `gcloud run deploy --source`. */
async function deploySingleContainer(
  ctx: DeployTargetContext
): Promise<{ url?: string }> {
  const { deployment, plan, serviceSettings, execute } = ctx;

  // The channel boxes the app as a local subprocess in the same container.
  // compose wrote that config by default; rewrite it in case a prior step
  // changed it.
  plan.writeChannelConfig(plan.channelConfig);

  // Write the shared multi-stage Dockerfile + .dockerignore.
  fs.writeFileSync(
    path.join(plan.stagingDir, 'Dockerfile'),
    renderSingleContainerDockerfile(plan)
  );
  fs.writeFileSync(
    path.join(plan.stagingDir, '.dockerignore'),
    ['**/node_modules', '**/.git', '**/.genkit', ''].join('\n')
  );

  const service = deployment.serviceName || deployment.name;
  const args = [
    'run',
    'deploy',
    service,
    '--source',
    plan.stagingDir,
    ...serviceSettingFlags(serviceSettings),
  ];
  if (deployment.region) args.push('--region', deployment.region);
  const envPairs = forwardedEnv(deployment.env);
  if (envPairs.length > 0) args.push('--set-env-vars', envPairs.join(','));

  const printable = printableCmd('gcloud', args);
  if (!execute) {
    logger.info(`[dry-run] would run:\n  ${printable}`);
    return {};
  }
  logger.info(`Deploying to Cloud Run (single-container):\n  ${printable}`);
  await run('gcloud', args);
  return {};
}

/**
 * sidecar: build + push two images and apply a multi-container service.yaml.
 *
 * The app container serves v1 reflection on loopback (`GENKIT_REFLECTION_PORT`)
 * and the channel calls into it through a remote runner, so neither side dials
 * the other at startup and no start ordering is needed. The remote runner waits
 * for the app's health endpoint before the first call. Both containers share a
 * reflection secret generated per deploy.
 */
async function deploySidecar(
  ctx: DeployTargetContext
): Promise<{ url?: string }> {
  const { deployment, plan, serviceSettings, execute } = ctx;
  const repo = deployment.imageRepo!;
  const tag = deployment.name;
  const channelImage = `${repo}/${tag}-channel:latest`;
  const userImage = `${repo}/${tag}-app:latest`;
  const service = deployment.serviceName || deployment.name;

  // The app runs in its own container and serves v1 reflection on loopback;
  // the channel reaches it with a remote runner. Routing/retention don't
  // apply to a runtime the channel doesn't own, so only `runner` changes.
  const sidecarConfig: ChannelConfigInput = {
    ...plan.channelConfig,
    box: {
      ...plan.channelConfig.box,
      runner: { type: 'remote', url: `http://127.0.0.1:${REFLECTION_PORT}` },
      route: 'app',
    },
  };
  plan.writeChannelConfig(sidecarConfig);
  // Shared by both containers: the app requires it on every reflection call.
  const reflectionSecret = randomBytes(32).toString('base64url');

  // Write the two Dockerfiles into the staging dir.
  const channelDf = path.join(plan.stagingDir, 'Dockerfile.channel');
  const userDf = path.join(plan.stagingDir, 'Dockerfile.app');
  fs.writeFileSync(channelDf, renderChannelDockerfile(plan));
  fs.writeFileSync(userDf, renderUserDockerfile(plan));
  fs.writeFileSync(
    path.join(plan.stagingDir, '.dockerignore'),
    ['**/node_modules', '**/.git', '**/.genkit', ''].join('\n')
  );

  // Write the multi-container service spec.
  const serviceYaml = renderServiceYaml({
    service,
    channelImage,
    userImage,
    reflectionSecret,
    userEnv: deployment.env ?? [],
    settings: serviceSettings,
  });
  const servicePath = path.join(plan.stagingDir, 'service.yaml');
  fs.writeFileSync(servicePath, serviceYaml);

  const buildChannel = [
    'builds',
    'submit',
    '--tag',
    channelImage,
    '--file',
    channelDf,
    plan.stagingDir,
  ];
  const buildUser = [
    'builds',
    'submit',
    '--tag',
    userImage,
    '--file',
    userDf,
    plan.stagingDir,
  ];
  const replace = ['run', 'services', 'replace', servicePath];
  if (deployment.region) replace.push('--region', deployment.region);

  // `services replace` never changes IAM, so public access needs an explicit
  // invoker binding for allUsers. Private access is the default (no binding).
  const iamBinding = iamBindingArgs(service, deployment.region, serviceSettings);

  if (!execute) {
    let msg =
      `[dry-run] sidecar packaging would:\n` +
      `  1. ${printableCmd('gcloud', buildChannel)}\n` +
      `  2. ${printableCmd('gcloud', buildUser)}\n` +
      `  3. ${printableCmd('gcloud', replace)}\n`;
    if (iamBinding) {
      msg += `  4. ${printableCmd('gcloud', iamBinding)}\n`;
    }
    msg += `Service spec written to:\n  ${servicePath}`;
    logger.info(msg);
    return {};
  }

  logger.info(`Building channel image:\n  ${printableCmd('gcloud', buildChannel)}`);
  await run('gcloud', buildChannel);
  logger.info(`Building app image:\n  ${printableCmd('gcloud', buildUser)}`);
  await run('gcloud', buildUser);
  logger.info(`Applying service spec:\n  ${printableCmd('gcloud', replace)}`);
  await run('gcloud', replace);
  if (iamBinding) {
    logger.info(
      `Granting public access:\n  ${printableCmd('gcloud', iamBinding)}`
    );
    await run('gcloud', iamBinding);
  }
  return {};
}

/**
 * Translates resolved service settings into `gcloud run deploy` flags
 * (single-container path). Access and CPU always emit their explicit flag so a
 * redeploy converges to the declared state rather than inheriting a prior one.
 */
function serviceSettingFlags(s: ResolvedServiceSettings): string[] {
  const args: string[] = [];
  args.push(
    s.access === 'public' ? '--allow-unauthenticated' : '--no-allow-unauthenticated'
  );
  args.push(
    s.cpu === 'always-allocated' ? '--no-cpu-throttling' : '--cpu-throttling'
  );
  if (s.minInstances !== undefined) {
    args.push('--min-instances', String(s.minInstances));
  }
  if (s.maxInstances !== undefined) {
    args.push('--max-instances', String(s.maxInstances));
  }
  if (s.concurrency !== undefined) {
    args.push('--concurrency', String(s.concurrency));
  }
  if (s.memory !== undefined) {
    args.push('--memory', s.memory);
  }
  return args;
}

/**
 * Builds the `gcloud run services add-iam-policy-binding` argv that makes the
 * service publicly invokable, or null when access is private.
 */
function iamBindingArgs(
  service: string,
  region: string | undefined,
  s: ResolvedServiceSettings
): string[] | null {
  if (s.access !== 'public') return null;
  const args = [
    'run',
    'services',
    'add-iam-policy-binding',
    service,
    '--member=allUsers',
    '--role=roles/run.invoker',
  ];
  if (region) args.push('--region', region);
  return args;
}

/**
 * Renders a Cloud Run multi-container service spec (Knative Service). The
 * channel is the ingress container (has the `ports` entry); the user app is a
 * sidecar serving reflection on loopback only.
 *
 * Service settings map to template annotations (CPU throttling, autoscaling
 * min/max), containerConcurrency, and the channel container's memory limit.
 * Access (public/private) is applied out of band via an IAM binding, not here.
 */
export function renderServiceYaml(opts: {
  service: string;
  channelImage: string;
  userImage: string;
  reflectionSecret: string;
  userEnv: string[];
  settings: ResolvedServiceSettings;
}): string {
  const { service, channelImage, userImage, reflectionSecret, userEnv, settings } =
    opts;

  const envLine = (name: string, value: string) =>
    `            - name: ${name}\n              value: ${jsonString(value)}`;

  // Env forwarded to the user app container (values come from the deploy env).
  const userEnvLines = userEnv
    .filter((k) => process.env[k] !== undefined)
    .map((k) => envLine(k, process.env[k]!));

  // Reflection on without GENKIT_ENV=dev (production defaults), bound to a
  // fixed loopback port and guarded by the shared secret. TODO: move the secret
  // to Secret Manager instead of a plain env value in the spec.
  const appEnv = [
    envLine('GENKIT_REFLECTION_ENABLED', 'true'),
    envLine('GENKIT_REFLECTION_PORT', String(REFLECTION_PORT)),
    envLine('GENKIT_REFLECTION_SECRET_TOKEN', reflectionSecret),
    ...userEnvLines,
  ].join('\n');
  const channelEnv = envLine('GENKIT_REFLECTION_SECRET_TOKEN', reflectionSecret);

  // Template annotations: CPU throttling + autoscaling bounds.
  const annotations: string[] = [
    `        run.googleapis.com/cpu-throttling: ${jsonString(
      settings.cpu === 'always-allocated' ? 'false' : 'true'
    )}`,
  ];
  if (settings.minInstances !== undefined) {
    annotations.push(
      `        autoscaling.knative.dev/minScale: ${jsonString(
        String(settings.minInstances)
      )}`
    );
  }
  if (settings.maxInstances !== undefined) {
    annotations.push(
      `        autoscaling.knative.dev/maxScale: ${jsonString(
        String(settings.maxInstances)
      )}`
    );
  }

  const concurrencyLine =
    settings.concurrency !== undefined
      ? `      containerConcurrency: ${settings.concurrency}\n`
      : '';

  // Memory limit applies to the channel (ingress) container.
  const channelResources =
    settings.memory !== undefined
      ? `          resources:\n            limits:\n              memory: ${jsonString(
          settings.memory
        )}\n`
      : '';

  return `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${service}
spec:
  template:
    metadata:
      annotations:
${annotations.join('\n')}
    spec:
${concurrencyLine}      containers:
        - name: channel
          image: ${channelImage}
          ports:
            - containerPort: 8080
${channelResources}          env:
${channelEnv}
          startupProbe:
            httpGet:
              path: /
              port: 8080
            periodSeconds: 1
            failureThreshold: 30
        - name: app
          image: ${userImage}
          env:
${appEnv}
`;
}

/** Filters and formats KEY=VALUE pairs for env vars present in the process. */
function forwardedEnv(keys: string[] | undefined): string[] {
  return (keys ?? [])
    .filter((k) => process.env[k] !== undefined)
    .map((k) => `${k}=${process.env[k]}`);
}

/** Minimal YAML-safe double-quoted string. */
function jsonString(s: string): string {
  return JSON.stringify(s);
}

function printableCmd(cmd: string, args: string[]): string {
  return `${cmd} ${args
    .map((a) => (a.includes(' ') ? `'${a}'` : a))
    .join(' ')}`;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}
