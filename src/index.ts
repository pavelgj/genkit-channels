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
 * Channel authors call {@link startAppProcess} to run a Genkit app as a child
 * process and talk to it over reflection v2, then map a transport (HTTP, Slack,
 * Discord, ...) onto its discovered actions. The returned {@link AppProcess}
 * self-configures from the framework's `channel.config.json` and exposes
 * `getConfig`, `listAgents`, and `getAgent` so a channel writes almost no
 * plumbing.
 */

export {
  AppProcess,
  startAppProcess,
  type ChannelConfig,
  type ChildSpec,
  type RunActionParams,
  type RunActionResult,
  type StartAppProcessOptions,
} from './lib/app-process';

export {
  createAgentApi,
  discoverAgents,
  type AgentAPI,
  type AgentChat,
  type AgentResponse,
  type AgentStateManagement,
  type AgentTurn,
  type CreateAgentApiOptions,
  type DiscoveredAgent,
} from './lib/agent-client';
