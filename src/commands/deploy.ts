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
 * `genkit-channels deploy` command.
 *
 * Composes a deployable artifact by bundling the installed Node channel with the
 * user's app (no codegen). Unless --build-only/--local, ships the artifact via a
 * pluggable target.
 */

import { spawn, spawnSync } from 'child_process';
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { compose } from '../core/compose';
import { loadManifest } from '../core/manifest';
import { resolveServiceSettings } from '../core/service-settings';
import { getTarget } from '../core/targets';
import type {
  ComposePlan,
  DeploymentManifest,
  PackagingName,
  TargetName,
} from '../core/types';

import { linkLocalLibrary } from '../util/local-library';
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
  .option('--local', 'compose and run the channel locally (no container)', false)
  .option('--all', 'process every deployment in the manifest', false)
  .option('--target <target>', 'override the manifest target (e.g. cloud-run)')
  .option(
    '--packaging <packaging>',
    'override packaging (single-container | sidecar)'
  )
  .option('--dry-run', 'print the deploy command without executing it', false)

  .action(async (name: string | undefined, options: DeployOptions) => {
    const projectRoot = await findProjectRoot();

    let config;
    try {
      config = loadManifest(projectRoot);
    } catch (e: any) {
      logger.error(e.message);
      process.exitCode = 1;
      return;
    }

    const selected = selectDeployments(config.deployments, name, options.all);
    if (selected instanceof Error) {
      logger.error(selected.message);
      process.exitCode = 1;
      return;
    }

    if (options.local && selected.length > 1) {
      logger.error('--local runs a single deployment; specify a name.');
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

function selectDeployments(
  deployments: DeploymentManifest[],
  name: string | undefined,
  all: boolean | undefined
): DeploymentManifest[] | Error {
  if (all) return deployments;
  if (!name) {
    if (deployments.length === 1) return deployments;
    return new Error(
      `Multiple deployments defined. Specify a name or use --all. ` +
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

async function processOne(
  projectRoot: string,
  deployment: DeploymentManifest,
  options: DeployOptions
) {
  // 1) Compose (packaging-neutral: copies channel + user, writes a default
  // managed config, describes how to build both sides).
  const plan = await compose(projectRoot, deployment);
  const { stagingDir } = plan;

  if (options.local) {
    await runLocal(projectRoot, plan);
    return;
  }

  if (options.buildOnly) {
    logger.info(
      `\nBuild-only: skipping deploy. Ship it yourself from:\n  ${stagingDir}\n` +
        `Or run locally:\n  node ${path.join(
          stagingDir,
          plan.channel.entryFromStaging
        )}`
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


/**
 * Runs the composed channel on the host (no container).
 *
 * Two adjustments vs the container path make local iteration fast:
 *  - install the staged channel's own deps if missing (the container does this
 *    via a Dockerfile RUN; locally we do it lazily), and
 *  - point the child at the *original* project (not the copied `user/`), so its
 *    existing node_modules and build output are reused. The app must already be
 *    built (run its build once); we do not build it here.
 */
async function runLocal(
  projectRoot: string,
  plan: ComposePlan
): Promise<void> {
  const { stagingDir, channel, runtime, expose, config } = plan;

  // --local runs the channel on the host. Node channels run their source
  // directly; Go channels would need a built binary. Keep local iteration to
  // Node channels for now (the container path covers Go).
  if (channel.build.language !== 'node') {
    throw new Error(
      `--local currently supports Node channels only (channel "${channel.definition.name}" ` +
        `is ${channel.build.language}). Use --build-only + docker, or the cloud-run target.`
    );
  }

  ensureChannelDeps(path.join(stagingDir, 'channel'));

  // Write a local config that runs the child from the real project dir so its
  // node_modules / built output are available.
  const localConfig = {
    child: {
      command: runtime.command,
      args: runtime.args,
      cwd: path.resolve(projectRoot, runtime.cwd),
    },
    expose,
    config,
    readyTimeoutMs: 30000,
  };
  const localConfigPath = path.join(stagingDir, 'channel.local.json');
  fs.writeFileSync(localConfigPath, JSON.stringify(localConfig, null, 2) + '\n');

  logger.info(
    `\nRunning locally from ${stagingDir}\n` +
      `  child: ${runtime.command} ${runtime.args.join(' ')} ` +
      `(cwd: ${localConfig.child.cwd})\n`
  );

  return new Promise((resolve, reject) => {
    const child = spawn('node', [channel.entryFromStaging], {
      cwd: stagingDir,
      env: {
        ...process.env,
        GENKIT_CHANNEL_CONFIG: localConfigPath,
      },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`channel exited with code ${code}`));
    });
  });
}


/** Installs the staged channel's npm deps if they are not present yet. */
function ensureChannelDeps(channelDir: string) {
  const pkgPath = path.join(channelDir, 'package.json');
  const hasPkg = fs.existsSync(pkgPath);
  const hasModules = fs.existsSync(path.join(channelDir, 'node_modules'));
  if (!hasPkg || hasModules) return;

  // The bundled channels depend on `genkit-channels` (this package) for the
  // helper library. It is not published to npm yet, so for local runs we point
  // the dependency at this package on disk and let npm link it. When the library
  // is published this rewrite becomes a no-op.
  linkLocalLibrary(pkgPath);

  logger.info(`Installing channel dependencies in ${channelDir} ...`);
  const res = spawnSync(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund'],
    {
      cwd: channelDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    }
  );
  if (res.status !== 0) {
    throw new Error('failed to install channel dependencies (npm install).');
  }
}


