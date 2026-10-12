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
 * genkit-channels/chat: the pieces every chat channel (Slack, Discord, ...)
 * needs, so a new one is mostly platform glue.
 *
 *   // One turn at a time per conversation, with the state the last turn
 *   // saved. Messages and state are plain JSON, so a persistent store can
 *   // hold them.
 *   const conversations = createConversations<Msg, State>({ coalesce, handler });
 *   conversations.post(threadKey, { id: event.id, payload: msg });
 *
 *   const out = messageRenderer({ post, edit }, 2000);
 *   await out.render(textSoFar);
 *
 *   const failure = describeFailure(e);
 *   await say(failure.userMessage);
 */

export {
  createConversations,
  type Conversations,
  type ConversationsOptions,
  type TurnHandler,
  type TurnInput,
} from './conversations';

export {
  TurnLostError,
  type ConversationDelivery,
  type ConversationMessage,
  type ConversationStore,
  type TakeOptions,
  type Turn,
} from './conversation-store';

export { memoryConversationStore } from './memory-conversations';

export type { JsonData } from './json';

export { filterAllowed, type AllowedBatch } from './authors';

export { sessionId } from './session';

export {
  messageRenderer,
  splitMessage,
  StreamSplitter,
  type MessageRenderer,
  type MessageSink,
} from './split';

export {
  DEFAULT_FAILURE_MESSAGES,
  describeFailure,
  type Failure,
  type FailureKind,
} from './failure';
