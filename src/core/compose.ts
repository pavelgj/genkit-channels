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
 * Composes a deployable staging directory for one deployment. Nothing is
 * generated from the user's code: we copy the installed channel and the user's
 * app side by side and write a `channel.config.json` describing how the channel
 * launches the app.
 *
 * compose is deliberately **packaging-neutral**: it gathers ingredients and
 * describes how to build both the channel and the user app, but it does not
 * decide how they are packaged (single image vs sidecar) or emit a Dockerfile /
 * service spec. That is the target's job, driven by the returned
 * {@link ComposePlan}. This keeps targets in control of platform-specific
 * artifacts (see `core/packaging` for shared helpers they can reuse).
 *
 * Layout produced under `.genkit/deploy/<name>/`:
 *   channel/              copy of the installed channel
 *   user/                 copy of the user project source
 *   channel.config.json   the resolved deployment `initChannel` reads: expose,
 *                         options, and how the app is boxed (an exec runner
 *                         over `user/` by default; targets may rewrite it)
 */

import fs from 'fs';
import path from 'path';
import { resolveChannelBuildPlan } from './channels/build-plan';
import { loadChannel } from './channels/loader';
import { validateChannelConfig } from './channels/validate';
import { resolveAgents, resolveFlows } from './manifest';
import { getRuntimeBuilder } from './runtimes';
import {
  resolveAgentDirRuntime,
  synthesizeAgentDirApp,
} from './runtimes/agent-dir';
import {
  CHANNEL_CONFIG_FILENAME,
  type ChannelConfigInput,
  type Expose,
} from '../lib/config';
import { contextProviderSecrets } from '../lib/context-providers';
import { buildChannelConfig } from './channel-config';
import { resolveSecrets, secretLikeNames } from './secrets';
import type {
  ComposeContext,
  ComposePlan,
  DeploymentManifest,
} from './types';
import { logger } from '../util/logger';


const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.genkit',
  'dist',
  'bin',
  '__pycache__',
  '.venv',
  'venv',
]);

// Generated build output dirs. Dropped from the user copy (rebuilt from source),
// but kept for the channel copy when it was built at install time (see compose).
const BUILD_OUTPUT_DIRS = new Set(['dist', 'bin']);


/** Composes the staging directory for a single deployment. */
export async function compose(
  projectDir: string,
  deployment: DeploymentManifest
): Promise<ComposePlan> {
  const channel = loadChannel(projectDir, deployment.channel);
  const channelBuild = resolveChannelBuildPlan(channel);

  // Runtime is optional. With no `runtime`, the framework runs the built-in
  // agent-dir runtime: a synthesized headless JS app that loads the project's
  // `agents/` folder. It resolves to an ordinary JS runtime so all downstream
  // packaging is unchanged.
  const usingAgentDir = !deployment.runtime;
  const runtime = usingAgentDir
    ? resolveAgentDirRuntime()
    : getRuntimeBuilder(deployment.runtime!.language).resolve(
        deployment.runtime!
      );

  const expose: Expose = {
    agents: resolveAgents(deployment),
    flows: resolveFlows(deployment),
    ...(deployment.expose?.contextProvider
      ? { contextProvider: deployment.expose.contextProvider }
      : {}),
  };
  const env = Array.from(
    new Set([...(channel.env ?? []), ...(deployment.env ?? [])])
  );
  const secrets = resolveSecrets({
    channelName: channel.name,
    // A built-in context provider's keys are checked in the channel, so they
    // are channel secrets: kept out of the app, still renameable through the
    // deployment's `secrets` map.
    channelSecrets: [
      ...(channel.secrets ?? []),
      ...contextProviderSecrets(deployment.expose?.contextProvider),
    ],
    deploymentSecrets: deployment.secrets,
  });
  const plainSecrets = secretLikeNames(deployment.env ?? []);
  if (plainSecrets.length > 0) {
    logger.warn(
      `Deployment "${deployment.name}": env ${plainSecrets.join(', ')} ` +
        `look${plainSecrets.length === 1 ? 's' : ''} like secrets. Values in ` +
        `\`env\` are deployed as plain env vars; move them to \`secrets\`.`
    );
  }

  const ctx: ComposeContext = {
    deployment,
    expose,
    config: deployment.with ?? {},
    env,
    child: { command: runtime.command, args: runtime.args, cwd: runtime.cwd },
  };
  await validateChannelConfig(channel, ctx);

  const stagingDir = path.join(projectDir, '.genkit', 'deploy', deployment.name);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  // 1) Copy the channel. Keep the channel's build output (e.g. a TypeScript
  // channel's `dist/`) so an install-time build is not thrown away: `dev`
  // runs the copied source directly, and the container build re-runs the build
  // anyway. (The user app copy below still drops generated dirs.)
  const channelDest = path.join(stagingDir, 'channel');
  copyDir(channel.dir, channelDest, { keepBuildOutput: true });


  // 2) Provide the "user" app. With a real runtime, copy the user's project
  // source. With the built-in agent-dir runtime, synthesize a small headless
  // app (index.mjs + package.json) plus a copy of the agents folder.
  const userDest = path.join(stagingDir, 'user');
  if (usingAgentDir) {
    const { agentCount } = synthesizeAgentDirApp(
      projectDir,
      userDest,
      deployment.agents
    );
    logger.info(
      `Using built-in agent-dir runtime (${agentCount} agent(s) from ` +
        `${deployment.agents?.dir ?? './agents'}).`
    );
  } else {
    copyDir(projectDir, userDest, { skipStagingRoot: stagingDir });
  }


  // 3) Write the resolved channel.config.json. Relative paths in it resolve
  // against the file's dir, so the app points at the copied `user/` dir.
  // Targets may rewrite it via ComposePlan.writeChannelConfig (e.g. sidecar
  // packaging switches to a remote runner).
  const configPath = path.join(stagingDir, CHANNEL_CONFIG_FILENAME);
  const channelConfigFor = (appDir: string): ChannelConfigInput =>
    buildChannelConfig({
      deployment,
      runtime,
      expose,
      secrets,
      appDir,
    });
  const channelConfig = channelConfigFor('user');
  writeChannelConfig(channelConfig);

  logger.info(
    `Composed ${deployment.channel} (${channel.language}) channel + ` +
      `${usingAgentDir ? 'agent-dir' : deployment.runtime!.language} app at ` +
      `${stagingDir}`
  );


  function writeChannelConfig(config: ChannelConfigInput): void {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  return {
    stagingDir,
    usingAgentDir,
    runtime,
    channel: {

      definition: channel,
      entryFromStaging: path.join('channel', channel.entry),
      build: channelBuild,
    },
    expose,
    config: deployment.with ?? {},
    env,
    secrets,
    writeChannelConfig,
    channelConfig,
    channelConfigFor,
  };
}

/**
 * Recursively copies a directory, skipping generated/vendor dirs.
 *  - `skipStagingRoot`: never copy the staging output into itself.
 *  - `keepBuildOutput`: keep build output dirs (`dist`, `bin`), used for the
 *    channel copy so an install-time build survives into staging.
 */
function copyDir(
  src: string,
  dest: string,
  opts: { skipStagingRoot?: string; keepBuildOutput?: boolean } = {}
) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    if (
      opts.skipStagingRoot &&
      path.resolve(s) === path.resolve(opts.skipStagingRoot)
    ) {
      continue; // never copy the staging output into itself
    }
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const ignored =
        opts.keepBuildOutput && BUILD_OUTPUT_DIRS.has(entry.name)
          ? false
          : IGNORED_DIRS.has(entry.name);
      if (ignored) continue;
      copyDir(s, d, opts);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

