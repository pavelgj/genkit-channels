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
 * genkit-channels/app: helpers for the user's app (the side that runs in the
 * box), as opposed to the channel side (`genkit-channels`).
 *
 * Imports genkit for types only, so loading this never pulls a second copy of
 * genkit into the app's process.
 */

import type { ActionContext } from 'genkit';
import {
  contextProviderFlowName,
  type ChannelRequest,
} from '../lib/channel-request';

export {
  contextProviderFlowName,
  type ChannelCaller,
  type ChannelRequest,
  type ChannelRequestMethod,
} from '../lib/channel-request';

/**
 * The part of a Genkit instance {@link defineContextProvider} needs.
 * Structural on purpose: `Genkit` has private members, which TypeScript
 * compares nominally, so an app on a different copy of genkit than this
 * library would not type-check against the class.
 */
export interface FlowRegistry {
  defineFlow(
    config: { name: string; metadata?: Record<string, unknown> },
    fn: (input: ChannelRequest) => Promise<ActionContext>
  ): unknown;
}

/**
 * Turns a channel request into action context (auth, caller identity, ...).
 * Throw `UserFacingError('UNAUTHENTICATED' | 'PERMISSION_DENIED', ...)` to
 * reject the caller; channels map those to 401/403 or a refusal message.
 */
export type ChannelContextProvider<C extends ActionContext = ActionContext> = (
  request: ChannelRequest
) => C | Promise<C>;

/**
 * Defines a context provider that channels select by name with
 * `expose.contextProvider` in channels.yaml. The channel calls it before
 * every agent turn or flow call and passes the result on as action context,
 * so tools and flows see it as `context`.
 *
 * ```ts
 * import { defineContextProvider } from 'genkit-channels/app';
 *
 * defineContextProvider(ai, { name: 'auth' }, async (req) => ({
 *   auth: await verifyIdToken(req.headers['authorization']),
 * }));
 * ```
 *
 * genkit's own providers fit too: `defineContextProvider(ai, { name: 'auth' },
 * apiKey(process.env.API_KEY))`.
 *
 * TODO: switch to `ai.defineContextProvider` once genkit core has it.
 */
export function defineContextProvider<C extends ActionContext>(
  ai: FlowRegistry,
  config: { name: string },
  provider: ChannelContextProvider<C>
): void {
  ai.defineFlow(
    {
      name: contextProviderFlowName(config.name),
      metadata: { genkitChannels: { kind: 'contextProvider' } },
    },
    // The channel library builds and normalizes the request, so the input is
    // trusted here. No input schema: a zod schema from this library's copy of
    // genkit would cross into the app's copy.
    async (request) => provider(request)
  );
}
