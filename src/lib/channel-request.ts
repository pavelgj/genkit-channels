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
 * The request a channel hands to the app's context provider, and the naming
 * convention that ties the two together.
 *
 * Shared by the channel side (`initChannel`) and the app side
 * (`genkit-channels/app`). Types only, plus one pure function: the app side
 * must not load a second copy of genkit into the user's process.
 */

/** HTTP methods, as in genkit's `RequestData`. */
export const CHANNEL_REQUEST_METHODS = [
  'GET',
  'PUT',
  'POST',
  'DELETE',
  'OPTIONS',
  'QUERY',
] as const;
export type ChannelRequestMethod = (typeof CHANNEL_REQUEST_METHODS)[number];

/**
 * Who is calling, for transports without HTTP headers (Slack, Discord, ...).
 * The channel fills in what the platform tells it; the provider decides what
 * it means.
 */
export interface ChannelCaller {
  /** `slack`, `discord`, `http`, ... */
  platform: string;
  user?: { id: string; displayName?: string };
  /** The workspace the call came from: a Slack team, a Discord guild. */
  tenant?: string;
}

/**
 * What a context provider receives. A superset of genkit's `RequestData`, so
 * genkit's own providers (e.g. `apiKey()` from `genkit/context`) work as is.
 */
export interface ChannelRequest {
  method: ChannelRequestMethod;
  /** Header names are lowercase. Empty for chat transports. */
  headers: Record<string, string>;
  /** The call's payload: an HTTP body, a chat message's text, ... */
  input: unknown;
  /** Chat transports describe the caller here instead of in headers. */
  channel?: ChannelCaller;
}

/**
 * The flow name a context provider is registered under. Go and Python apps
 * (which have no `defineContextProvider` yet) define a flow with this name:
 * `ChannelRequest` in, a JSON object (the action context) out.
 *
 * Hidden behind a function so the switch to genkit's own context provider
 * actions (once core has them) is one place.
 */
export function contextProviderFlowName(name: string): string {
  return `contextProvider/${name}`;
}
