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
 * Single-container packaging: one image runs the channel, which boxes the user
 * app as a local subprocess (box exec runner). The image must therefore host
 * both the channel's runtime (Node) and the user app's runtime: the user
 * runtime's `runtimeSetup` (e.g. Python) is layered on the Node base. A Go user
 * app is a static binary and needs nothing extra.
 *
 * This helper is shared: any target that ships a single image can render this
 * Dockerfile and hand it to its build path.
 */

import { IMAGE_CHANNEL_DIR } from '../channels/build-plan';
import type { ComposePlan } from '../types';

/**
 * Renders a multi-stage Dockerfile for single-container packaging. Stages:
 *  1. userbuild: build the user app with its toolchain.
 *  2. final: Node base plus the user runtime; copy channel + user artifacts;
 *     run the channel.
 */
export function renderSingleContainerDockerfile(plan: ComposePlan): string {
  const { runtime, channel } = plan;
  const df = runtime.dockerfile;
  const cb = channel.build;
  const lines: string[] = [];

  lines.push('# syntax=docker/dockerfile:1');
  lines.push('');

  lines.push('# --- Stage 1: build the user app ---');
  lines.push(`FROM ${df.builderImage} AS userbuild`);
  lines.push('COPY user/ /workspace/user/');
  for (const step of df.buildSteps) lines.push(step);
  lines.push('');

  lines.push('# --- Final stage: channel + user app runtime ---');
  lines.push(`FROM ${cb.runtimeImage} AS runtime`);
  for (const setup of df.runtimeSetup ?? []) lines.push(setup);
  lines.push('WORKDIR /app');

  lines.push(`COPY channel/ ${IMAGE_CHANNEL_DIR}/`);
  for (const step of cb.buildSteps) lines.push(`RUN ${step}`);
  lines.push('COPY channel.config.json /app/channel.config.json');

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
