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
 * Derives how to build a channel's own container image from its definition.
 *
 * Channels are Node programs (they build on `initChannel` and `@genkit-ai/box`,
 * which are JS today). Everything downstream (packagers, targets) consumes the
 * neutral {@link ChannelBuildPlan}.
 *
 * Conventions for the composed image layout (both packagings):
 *  - the channel is copied to `/app/channel`,
 *  - `channel.config.json` lives at `/app/channel.config.json`.
 */

import type { ChannelBuildPlan, ChannelDefinition } from '../types';

/** Where the channel is copied inside the image. */
const CHANNEL_DIR = '/app/channel';

/** Base image for the channel. */
const NODE_RUNTIME_IMAGE = 'node:20-slim';

/**
 * Resolves a channel's build plan: run the copied source after an
 * `npm install`, or after the channel's declared `build` (e.g. TypeScript).
 */
export function resolveChannelBuildPlan(
  def: ChannelDefinition
): ChannelBuildPlan {
  // `entry` is relative to the channel dir, e.g. `src/index.js` (plain JS) or
  // `dist/index.js` (a TypeScript channel that compiles to `dist/`).
  const entry = `${CHANNEL_DIR}/${def.entry}`;
  // A plain Node channel runs its copied source after installing prod deps. A
  // Node channel that declares a `build` (e.g. TypeScript) needs its dev deps to
  // compile, so we run the declared build (typically `npm install && npm run
  // build`) instead. Steps are shell fragments (no `RUN` keyword; the packager
  // adds it).
  const buildSteps = def.build
    ? [`cd ${CHANNEL_DIR} && ${def.build}`]
    : [`cd ${CHANNEL_DIR} && npm install --omit=dev`];
  return {
    language: 'node',
    runtimeImage: NODE_RUNTIME_IMAGE,
    buildSteps,
    runCommand: ['node', entry],
  };
}


/** The in-image channel directory (shared with packagers). */
export const IMAGE_CHANNEL_DIR = CHANNEL_DIR;
