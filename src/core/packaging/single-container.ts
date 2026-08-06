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
 * Single-container packaging: one image runs the channel, which spawns the user
 * app as a child (managed mode). The image must therefore host both the
 * channel's runtime and the user app's runtime.
 *
 * The final base image is chosen so both can run:
 *  - Node channel: base is Node; the user's runtime (e.g. Python) is layered on
 *    top via the user runtime's `runtimeSetup`. (A Go user app is a static
 *    binary and needs nothing.)
 *  - Go channel: the channel is a static binary copied in, so the base is chosen
 *    to satisfy the *user* runtime (Node for js, Python for python, or a minimal
 *    static base when the user app is also Go).
 *
 * This helper is shared: any target that ships a single image can render this
 * Dockerfile and hand it to its build path.
 */

import { IMAGE_CHANNEL_DIR } from '../channels/build-plan';
import type { ComposePlan, RuntimeLanguage } from '../types';

const NODE_BASE = 'node:20-slim';
const PYTHON_BASE = 'python:3.12-slim';
const STATIC_BASE = 'gcr.io/distroless/static-debian12';

/**
 * Renders a multi-stage Dockerfile for single-container packaging. Stages:
 *  1. userbuild: build the user app with its toolchain.
 *  2. channelbuild (Go channel only): compile the channel binary.
 *  3. final: base chosen to run both; copy channel + user artifacts; run channel.
 */
export function renderSingleContainerDockerfile(plan: ComposePlan): string {
  const { runtime, channel } = plan;
  const df = runtime.dockerfile;
  const cb = channel.build;
  const lines: string[] = [];


  lines.push('# syntax=docker/dockerfile:1');
  lines.push('');

  // --- Stage 1: build the user app ---
  lines.push('# --- Stage 1: build the user app ---');
  lines.push(`FROM ${df.builderImage} AS userbuild`);
  lines.push('COPY user/ /workspace/user/');
  for (const step of df.buildSteps) lines.push(step);
  lines.push('');

  // --- Stage 2: build the channel (Go channels compile a binary) ---
  const goChannel = cb.language === 'go';
  if (goChannel) {
    lines.push('# --- Stage 2: build the channel ---');
    lines.push(`FROM ${cb.builderImage} AS channelbuild`);
    lines.push(`COPY channel/ ${IMAGE_CHANNEL_DIR}/`);
    lines.push(`WORKDIR ${IMAGE_CHANNEL_DIR}`);
    for (const step of cb.buildSteps) lines.push(`RUN ${step}`);
    lines.push('');
  }

  // --- Final stage: runtime hosting both channel and user app ---
  const finalBase = resolveFinalBase(cb.language, runtime.language);

  lines.push('# --- Final stage: channel + user app runtime ---');
  lines.push(`FROM ${finalBase} AS runtime`);

  // If the Node channel is the base, the user runtime may still need packages
  // installed (e.g. Python). For a Go channel we picked a base that already
  // satisfies the user runtime, so we skip runtimeSetup there.
  if (!goChannel) {
    for (const setup of df.runtimeSetup ?? []) lines.push(setup);
  }

  lines.push('WORKDIR /app');

  // Channel: Node copies source + installs deps; Go copies the built binary.
  if (goChannel) {
    // The binary path inside the image is the channel's runCommand[0].
    const binary = cb.runCommand[0];
    lines.push(`COPY --from=channelbuild ${binary} ${binary}`);
  } else {
    lines.push(`COPY channel/ ${IMAGE_CHANNEL_DIR}/`);
    for (const step of cb.buildSteps) lines.push(`RUN ${step}`);
  }

  lines.push('COPY channel.config.json /app/channel.config.json');

  // User artifacts from the build stage.
  for (const art of df.copyArtifacts) {
    lines.push(`COPY --from=userbuild ${art.from} ${art.to}`);
  }

  lines.push('ENV GENKIT_CHANNEL_CONFIG=/app/channel.config.json');
  lines.push('ENV PORT=8080');
  lines.push('EXPOSE 8080');
  lines.push(`CMD ${JSON.stringify(cb.runCommand)}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Chooses the final base image. When the channel is Node, the base is Node and
 * the user runtime is layered on top (handled by the caller via runtimeSetup).
 * When the channel is Go (a static binary), the base is chosen to run the user
 * app directly.
 */
function resolveFinalBase(
  channelLang: 'node' | 'go',
  userLang: RuntimeLanguage | undefined
): string {
  if (channelLang === 'node') return NODE_BASE;
  // Go channel: pick a base that provides the user runtime.
  switch (userLang) {
    case 'js':
      return NODE_BASE;
    case 'python':
      return PYTHON_BASE;
    case 'go':
    default:
      // A Go user app is a static binary; a minimal base is enough. If we could
      // not infer the language, fall back to Node (the most common) to be safe.
      return userLang === 'go' ? STATIC_BASE : NODE_BASE;
  }
}

