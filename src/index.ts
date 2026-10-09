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
 * genkit-channels: public library surface.
 *
 * A channel calls {@link initChannel} to reach the user's Genkit app, which
 * runs in a box (`@genkit-ai/box`) as configured in `channels.yaml`. It then
 * maps a transport (HTTP, Slack, Discord, ...) onto the agents and flows the
 * deployment exposes.
 */

export {
  initChannel,
  type Channel,
  type InitChannelOptions,
} from './lib/channel';

export {
  BoxConfigSchema,
  ChannelConfigSchema,
  type AgentState,
  type BoxConfig,
  type ChannelConfig,
  type ChannelConfigInput,
  type RunnerConfig,
} from './lib/config';

// The agent client surface, so channels can annotate against it without a
// direct genkit/beta import.
export type {
  AgentAPI,
  AgentChat,
  AgentChunk,
  AgentResponse,
  AgentTurn,
  SessionState,
} from 'genkit/beta';
