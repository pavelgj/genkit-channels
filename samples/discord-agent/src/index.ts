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
 * Genkit; the genkit-channels Discord channel discovers it over reflection v2
 * and drives it as a Discord bot. There is no HTTP server to start here: the
 * channel runs this file as a headless child process.
 */

import './agent.js';
