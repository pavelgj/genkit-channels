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
 * This is the channel-side analog of the per-language user runtime builders: it
 * is the only part of the tool that needs to know a channel is written in Node
 * vs Go. Everything downstream (packagers, targets) consumes the neutral
 * {@link ChannelBuildPlan}.
 *
 * Conventions for the composed image layout (both packagings):
 *  - the channel is copied to `/app/channel`,
 *  - `channel.config.json` lives at `/app/channel.config.json`.
 */

import type { ChannelBuildPlan, ChannelDefinition } from '../types';

/** Where the channel is copied inside the image. */
const CHANNEL_DIR = '/app/channel';

/** Default base images per channel language. */
const NODE_RUNTIME_IMAGE = 'node:20-slim';
const GO_BUILDER_IMAGE = 'golang:1.23';
// Go channels compile to a static binary, so the runtime image can be tiny.
const GO_RUNTIME_IMAGE = 'gcr.io/distroless/static-debian12';

/**
 * Resolves a channel's build plan. Node channels run their copied source after
 * an `npm install`; Go channels compile to a static binary in a build stage.
 */
export function resolveChannelBuildPlan(
  def: ChannelDefinition
): ChannelBuildPlan {
  if (def.language === 'go') {
    return resolveGo(def);
  }
  return resolveNode(def);
}

function resolveNode(def: ChannelDefinition): ChannelBuildPlan {
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


function resolveGo(def: ChannelDefinition): ChannelBuildPlan {
  // `entry` points at the built binary path relative to the channel dir, e.g.
  // `bin/app`. The build command defaults to compiling that binary.
  const binaryRel = def.entry; // e.g. bin/app
  const build = def.build ?? `go build -o ${binaryRel} .`;
  return {
    language: 'go',
    builderImage: GO_BUILDER_IMAGE,
    runtimeImage: GO_RUNTIME_IMAGE,
    // Runs in the build stage, inside the copied channel source dir.
    buildSteps: [`CGO_ENABLED=0 ${build}`],
    // The compiled binary is copied to `${CHANNEL_DIR}/<entry>` in the final
    // image (the packager wires up the COPY --from).
    runCommand: [`${CHANNEL_DIR}/${binaryRel}`],
  };
}

/** The in-image channel directory (shared with packagers). */
export const IMAGE_CHANNEL_DIR = CHANNEL_DIR;
