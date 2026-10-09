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
 * App entry point. Importing the agent module is enough to register it with
 * Genkit; the genkit-channels Discord channel drives it as a Discord bot. There
 * is no HTTP server to start here: the channel runs this file headless in a box
 * (see `box` in channels.yaml).
 */

import './agent.js';
