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
 * `genkit-channel dev` command: compose one deployment and run it on the host
 * (no container), with secrets from `.env` files. Same staging dir as
 * `deploy`, so what you test locally is what ships.
 */

import { Command } from 'commander';
import { compose } from '../core/compose';
import { runLocal } from '../core/local-run';
import { loadManifest, selectDeployments } from '../core/manifest';
import { logger } from '../util/logger';
import { findProjectRoot } from '../util/project-root';

export const dev = new Command('dev')
  .description('run a deployment locally (no container)')
  .argument(
    '[name]',
    'deployment name from channels.yaml (optional if there is only one)'
  )
  .action(async (name: string | undefined) => {
    const projectRoot = await findProjectRoot();
    try {
      const config = loadManifest(projectRoot);
      // dev runs exactly one deployment, so no --all.
      const selected = selectDeployments(config.deployments, name);
      if (selected instanceof Error) throw selected;
      const [deployment] = selected;

      logger.info(`\n=== ${deployment.name} (${deployment.channel}) ===`);
      const plan = await compose(projectRoot, deployment);
      await runLocal(projectRoot, deployment.name, plan);
    } catch (e) {
      logger.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });
