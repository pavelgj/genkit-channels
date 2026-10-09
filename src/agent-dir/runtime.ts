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
 * The built-in agent-dir runtime: a headless Genkit app the framework spawns
 * when a deployment declares no `runtime` of its own. It is deliberately tiny.
 * It calls {@link loadAgentDir} (default middleware + auto model providers + the
 * agent folder), then idles so the channel's box can drive it over reflection,
 * exactly like any hand-written user runtime.
 *
 * The agents directory and default model come from env the compose step sets
 * (`GENKIT_AGENTS_DIR`, `GENKIT_AGENTS_MODEL`), defaulting to `./agents` and the
 * library default model.
 */

import { loadAgentDir } from './load';

const dir = process.env.GENKIT_AGENTS_DIR || undefined;
const defaultModel = process.env.GENKIT_AGENTS_MODEL || undefined;

// Constructing the instance registers the agents and starts reflection (the
// box runner turns it on via GENKIT_REFLECTION_ENABLED).
loadAgentDir({ dir, defaultModel });

console.log(
  `[agent-dir] runtime up (dir: ${dir ?? './agents'}` +
    `${defaultModel ? `, model: ${defaultModel}` : ''})`
);

// Stay alive (headless): the channel drives us over reflection.
setInterval(() => {}, 1 << 30);
