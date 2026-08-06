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
 * Sidecar packaging: the channel and the user app become two separate images
 * that run as sibling containers sharing localhost. The channel is the ingress
 * container on `$PORT`; it binds the reflection v2 WS server on a fixed loopback
 * port and waits (attached mode). The user app container dials that port and
 * registers.
 *
 * This helper renders the two Dockerfiles. The platform-specific wiring (which
 * container is ingress, container start ordering, the service spec) is the
 * target's job, since it differs per platform. Keeping the images here means any
 * multi-container target can reuse them.
 *
 * Layout differences from single-container:
 *  - each image contains only its own runtime (channel XOR user), which is the
 *    whole point: no more one image carrying both toolchains.
 *  - the channel image has no user code; the user image has no channel code.
 */

import { IMAGE_CHANNEL_DIR } from '../channels/build-plan';
import type { ComposePlan } from '../types';

/** In-image path of the user app dir (mirrors single-container's `/app/user`). */
const IMAGE_USER_DIR = '/app/user';

/**
 * Renders the channel image Dockerfile. The channel runs in attached mode and
 * reads `channel.config.json` (baked in at `/app/channel.config.json`). It
 * contains no user code.
 */
export function renderChannelDockerfile(plan: ComposePlan): string {
  const cb = plan.channel.build;
  const lines: string[] = [];

  lines.push('# syntax=docker/dockerfile:1');
  lines.push('# Channel image (sidecar packaging): ingress container.');
  lines.push('');

  if (cb.language === 'go') {
    lines.push('# --- Build the channel binary ---');
    lines.push(`FROM ${cb.builderImage} AS channelbuild`);
    lines.push(`COPY channel/ ${IMAGE_CHANNEL_DIR}/`);
    lines.push(`WORKDIR ${IMAGE_CHANNEL_DIR}`);
    for (const step of cb.buildSteps) lines.push(`RUN ${step}`);
    lines.push('');
    lines.push('# --- Runtime ---');
    lines.push(`FROM ${cb.runtimeImage} AS runtime`);
    lines.push('WORKDIR /app');
    const binary = cb.runCommand[0];
    lines.push(`COPY --from=channelbuild ${binary} ${binary}`);
  } else {
    lines.push(`FROM ${cb.runtimeImage} AS runtime`);
    lines.push('WORKDIR /app');
    lines.push(`COPY channel/ ${IMAGE_CHANNEL_DIR}/`);
    for (const step of cb.buildSteps) lines.push(`RUN ${step}`);
  }

  lines.push('COPY channel.config.json /app/channel.config.json');
  lines.push('ENV GENKIT_CHANNEL_CONFIG=/app/channel.config.json');
  lines.push('ENV PORT=8080');
  lines.push('EXPOSE 8080');
  lines.push(`CMD ${JSON.stringify(cb.runCommand)}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Renders the user app image Dockerfile. The app runs headless and dials the
 * channel over loopback. The reflection v2 server URL and `GENKIT_ENV=dev` are
 * injected by the target (env on the container), not baked here, so the image is
 * reusable across environments.
 */
export function renderUserDockerfile(plan: ComposePlan): string {
  const df = plan.runtime.dockerfile;
  const runtime = plan.runtime;
  const lines: string[] = [];

  lines.push('# syntax=docker/dockerfile:1');
  lines.push('# User app image (sidecar packaging): headless, dials the channel.');
  lines.push('');

  // Build stage: same steps as single-container's user build.
  lines.push('# --- Build the user app ---');
  lines.push(`FROM ${df.builderImage} AS userbuild`);
  lines.push('COPY user/ /workspace/user/');
  for (const step of df.buildSteps) lines.push(step);
  lines.push('');

  // Runtime stage: a base that can run the user app.
  lines.push('# --- Runtime ---');
  lines.push(`FROM ${userRuntimeBase(runtime.language)} AS runtime`);
  for (const setup of df.runtimeSetup ?? []) lines.push(setup);
  lines.push('WORKDIR /app');

  // Copy the user artifacts. The build stage places them under /app/user in the
  // single-container layout via copyArtifacts.to; reuse the same destinations.
  for (const art of df.copyArtifacts) {
    lines.push(`COPY --from=userbuild ${art.from} ${art.to}`);
  }

  // Working dir for the child, relative to the staged user dir.
  const workdir =
    runtime.cwd && runtime.cwd !== '.'
      ? `${IMAGE_USER_DIR}/${runtime.cwd}`
      : IMAGE_USER_DIR;
  lines.push(`WORKDIR ${workdir}`);
  // No PORT for the headless app; the channel owns ingress.
  lines.push(`CMD ${JSON.stringify([runtime.command, ...runtime.args])}`);
  lines.push('');
  return lines.join('\n');
}

/** A runtime base image that can run the user app of a given language. */
function userRuntimeBase(language: string): string {
  switch (language) {
    case 'js':
      return 'node:20-slim';
    case 'python':
      return 'python:3.12-slim';
    case 'go':
    default:
      return 'gcr.io/distroless/static-debian12';
  }
}
