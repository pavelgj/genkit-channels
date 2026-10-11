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
 * `genkit-channel deploy` command.
 *
 * Composes a deployable artifact by bundling the installed Node channel with the
 * user's app (no codegen). Unless --build-only, ships the artifact via a
 * pluggable target. Running locally is `genkit-channel dev` (see ./dev.ts).
 */

import { Command, Option } from 'commander';
import { compose } from '../core/compose';
import { loadManifest, selectDeployments } from '../core/manifest';
import { resolveServiceSettings } from '../core/service-settings';
import { getTarget } from '../core/targets';
import type {
  DeploymentManifest,
  PackagingName,
  TargetName,
} from '../core/types';
import { logger } from '../util/logger';
import { findProjectRoot } from '../util/project-root';

interface DeployOptions {
  buildOnly?: boolean;
  local?: boolean;
  all?: boolean;
  target?: TargetName;
  packaging?: PackagingName;
  dryRun?: boolean;
}

export const deploy = new Command('deploy')
  .description(
    'bundle your Genkit app in a channel and (optionally) ship it to a platform'
  )
  .argument('[name]', 'deployment name from channels.yaml')
  .option('--build-only', 'only compose the staging dir; do not deploy', false)
  .option('--all', 'process every deployment in the manifest', false)
  .option('--target <target>', 'override the manifest target (e.g. cloud-run)')
  .option(
    '--packaging <packaging>',
    'override packaging (single-container | sidecar)'
  )
  .option('--dry-run', 'print the deploy command without executing it', false)
  // Replaced by `dev`. Kept hidden so old instructions get a pointer instead
  // of commander's generic "unknown option".
  .addOption(new Option('--local').hideHelp())

  .action(async (name: string | undefined, options: DeployOptions) => {
    if (options.local) {
      logger.error(
        `--local was replaced by: genkit-channel dev${name ? ` ${name}` : ''}`
      );
      process.exitCode = 1;
      return;
    }

    const projectRoot = await findProjectRoot();

    let config;
    try {
      config = loadManifest(projectRoot);
    } catch (e: any) {
      logger.error(e.message);
      process.exitCode = 1;
      return;
    }

    const selected = selectDeployments(config.deployments, name, {
      all: options.all,
      allowAll: true,
    });
    if (selected instanceof Error) {
      logger.error(selected.message);
      process.exitCode = 1;
      return;
    }

    for (const deployment of selected) {
      logger.info(`\n=== ${deployment.name} (${deployment.channel}) ===`);
      try {
        await processOne(projectRoot, deployment, options);
      } catch (e: any) {
        logger.error(`Deployment "${deployment.name}" failed: ${e.message}`);
        process.exitCode = 1;
        return;
      }
    }
  });

async function processOne(
  projectRoot: string,
  deployment: DeploymentManifest,
  options: DeployOptions
) {
  // 1) Compose (packaging-neutral: copies channel + user, writes a default
  // managed config, describes how to build both sides).
  const plan = await compose(projectRoot, deployment);
  const { stagingDir } = plan;

  if (options.buildOnly) {
    logger.info(
      `\nBuild-only: skipping deploy. Ship it yourself from:\n  ${stagingDir}\n` +
        `Or run it locally:\n  genkit-channel dev ${deployment.name}`
    );
    return;
  }

  // 2) Ship it via the target, which owns packaging + artifact generation.
  const targetName = options.target ?? deployment.target;
  if (!targetName) {
    logger.warn(
      `No target set for "${deployment.name}" (manifest.target or --target). ` +
        `Composed artifact only.\n  ${stagingDir}`
    );
    return;
  }

  const target = getTarget(targetName);

  // Resolve packaging: CLI override, then manifest, then the target default.
  const packaging = options.packaging ?? deployment.packaging ??
    target.defaultPackaging;
  if (!target.supportedPackagings.includes(packaging)) {
    throw new Error(
      `Target "${target.name}" does not support packaging "${packaging}". ` +
        `Supported: ${target.supportedPackagings.join(', ')}.`
    );
  }

  // Resolve service settings (user > channel recommendation > secure default)
  // and surface any advisory notices (opt-in hints, cost warnings).
  const { settings: serviceSettings, notices } = resolveServiceSettings(
    deployment.service,
    plan.channel.definition.recommends?.service
  );
  for (const notice of notices) {
    logger.warn(`Deployment "${deployment.name}": ${notice}`);
  }

  const ctx = {
    deployment,
    stagingDir,
    plan,
    packaging,
    serviceSettings,
    execute: !options.dryRun,
  };
  await target.validate(ctx);

  const { url } = await target.deploy(ctx);
  if (url) logger.info(`Deployed: ${url}`);
}
