// Copyright 2025 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Package agent is the Go counterpart of the Node agent-client helper: it drives
// a Genkit agent over reflection v2.
//
// A channel that talks to agents (Discord, Slack, ...) wants an ergonomic chat
// surface (start a chat, send a turn, stream the reply) rather than raw
// runAction calls. This package provides that: an agent turn becomes a streaming
// runAction, and the getSnapshot / abort companion actions become plain
// runAction calls to the agent's /agent-snapshot/* and /agent-abort/* keys.
//
// The package is transport-agnostic. It runs over any Transport; the appproc
// package supplies one backed by the in-process reflection link, so a Go channel
// gets the same chat surface it would get from a remote agent client, but the
// calls ride the reflection link instead of HTTP.
//
//	app, _ := appproc.Start()
//	agent, _ := app.GetAgent(ctx)          // discover + build the client
//	chat := agent.Chat(agent.WithSession(sessionID))
//	turn := chat.SendStream(ctx, agent.TextInput("hello"))
//	for chunk := range turn.Chunks {
//		fmt.Print(chunk.Text)
//	}
//	res, err := turn.Response()
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// StateManagement declares who owns an agent's session state.
//
//   - Server: the agent has a session store; history persists server-side and is
//     addressed by sessionId. Turns carry a snapshotId on the wire.
//   - Client: no store; the caller round-trips the full session state blob. Turns
//     carry the state on the wire.
type StateManagement string

const (
	// StateServer marks a server-managed (stored) agent.
	StateServer StateManagement = "server"
	// StateClient marks a client-managed (stateless) agent.
	StateClient StateManagement = "client"
)

// The /agent/<name> prefix that marks an agent action.
const agentKeyPrefix = "/agent/"

// DiscoveredAgent is an agent action plus the capability metadata a channel
// needs to drive it.
type DiscoveredAgent struct {
	// Key is the full action key, e.g. /agent/weatherAgent.
	Key string
	// Name is the short agent name, e.g. weatherAgent.
	Name string
	// StateManagement is "server" or "client" when the runtime reported it, and
	// "" when it did not (the client then auto-detects from the first turn).
	StateManagement StateManagement
	// Abortable reports whether the agent's invocations can be aborted.
	Abortable bool
}

// DiscoverAgents extracts the agents from a listActions map, with the capability
// metadata a channel needs to drive them. It keeps only /agent/* entries. This
// is the pure core behind AppProcess.ListAgents.
func DiscoverAgents(actions map[string]json.RawMessage) []DiscoveredAgent {
	var out []DiscoveredAgent
	for key, meta := range actions {
		if !strings.HasPrefix(key, agentKeyPrefix) {
			continue
		}
		var m struct {
			Metadata struct {
				Agent struct {
					StateManagement string `json:"stateManagement"`
					Abortable       bool   `json:"abortable"`
				} `json:"agent"`
			} `json:"metadata"`
		}
		_ = json.Unmarshal(meta, &m)
		out = append(out, DiscoveredAgent{
			Key:             key,
			Name:            strings.TrimPrefix(key, agentKeyPrefix),
			StateManagement: StateManagement(m.Metadata.Agent.StateManagement),
			Abortable:       m.Metadata.Agent.Abortable,
		})
	}
	// Stable order so callers (and logs) are deterministic.
	sortByName(out)
	return out
}

func sortByName(a []DiscoveredAgent) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j-1].Name > a[j].Name; j-- {
			a[j-1], a[j] = a[j], a[j-1]
		}
	}
}

// TurnParams configure a single agent turn dispatched over a Transport.
type TurnParams struct {
	// Key is the agent action key, e.g. /agent/weatherAgent.
	Key string
	// Input is the JSON-encoded AgentInput for this turn.
	Input json.RawMessage
	// Init is the JSON-encoded AgentInit (snapshotId / sessionId / state).
	Init json.RawMessage
	// OnChunk receives each raw AgentStreamChunk as it streams.
	OnChunk func(chunk json.RawMessage)
	// OnTraceID receives the trace id once the runtime reports it.
	OnTraceID func(traceID string)
}

// Transport is the pluggable backend the agent client runs over. The appproc
// package implements it on top of the reflection v2 link.
type Transport interface {
	// RunTurn runs an agent turn, streaming AgentStreamChunk JSON via
	// params.OnChunk, and returns the final AgentOutput JSON.
	RunTurn(ctx context.Context, params TurnParams) (json.RawMessage, error)
	// Run runs a plain action (the snapshot/abort companions), returning the
	// action's result JSON.
	Run(ctx context.Context, key string, input json.RawMessage) (json.RawMessage, error)
}

// Options configure an API.
type Options struct {
	// Key is the agent action key, e.g. /agent/weatherAgent.
	Key string
	// StateManagement, when known, skips the first-turn auto-detection. Pass the
	// value from DiscoverAgents.
	StateManagement StateManagement
}

// API is the ergonomic client for one agent. It is the Go analog of the JS
// AgentAPI returned by remoteAgent / ai.defineAgent.
type API struct {
	transport       Transport
	key             string
	name            string
	stateManagement StateManagement
}

// New builds an API for one agent over a Transport.
func New(transport Transport, opts Options) *API {
	return &API{
		transport:       transport,
		key:             opts.Key,
		name:            strings.TrimPrefix(opts.Key, agentKeyPrefix),
		stateManagement: opts.StateManagement,
	}
}

// Key returns the agent's full action key (e.g. /agent/weatherAgent).
func (a *API) Key() string { return a.key }

// Name returns the agent's short name (e.g. weatherAgent).
func (a *API) Name() string { return a.name }

// StateManagement returns the agent's declared state ownership, or "" when the
// runtime did not report it (the chat auto-detects on the first turn).
func (a *API) StateManagement() StateManagement { return a.stateManagement }

// ChatOption customizes a new chat (attach to an existing session or seed
// client-managed state).
type ChatOption func(*Chat)

// WithSession attaches the chat to an existing server-managed session by id.
func WithSession(sessionID string) ChatOption {
	return func(c *Chat) { c.sessionID = sessionID }
}

// WithSnapshot attaches the chat to an exact server snapshot by id.
func WithSnapshot(snapshotID string) ChatOption {
	return func(c *Chat) { c.snapshotID = snapshotID }
}

// WithState seeds a client-managed chat with a prior SessionState blob (the raw
// JSON returned as Response.SessionState on the previous turn).
func WithState(state json.RawMessage) ChatOption {
	return func(c *Chat) { c.clientState = state }
}

// Chat starts a new stateful conversation with the agent. State (snapshotId for
// server-managed agents, the session state blob for client-managed ones) is
// tracked across turns so callers do not thread it by hand.
func (a *API) Chat(opts ...ChatOption) *Chat {
	c := &Chat{
		transport:       a.transport,
		key:             a.key,
		stateManagement: a.stateManagement,
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// GetSnapshot reads a session snapshot without starting a chat. Requires a
// server-managed agent. Returns nil when no snapshot is found.
func (a *API) GetSnapshot(ctx context.Context, lookup SnapshotLookup) (json.RawMessage, error) {
	input, err := json.Marshal(lookup)
	if err != nil {
		return nil, err
	}
	res, err := a.transport.Run(ctx, snapshotKey(a.name), input)
	if err != nil {
		return nil, err
	}
	if isJSONNull(res) {
		return nil, nil
	}
	return res, nil
}

// Abort aborts a running snapshot. Requires a server-managed agent. Returns the
// snapshot's resulting status (e.g. "aborted"), or "" when unknown.
func (a *API) Abort(ctx context.Context, snapshotID string) (string, error) {
	input, _ := json.Marshal(map[string]string{"snapshotId": snapshotID})
	res, err := a.transport.Run(ctx, abortKey(a.name), input)
	if err != nil {
		return "", err
	}
	var out struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(res, &out)
	return out.Status, nil
}

// SnapshotLookup identifies a snapshot to load. Provide exactly one field.
type SnapshotLookup struct {
	SnapshotID string `json:"snapshotId,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
}

func snapshotKey(name string) string { return "/agent-snapshot/" + name }
func abortKey(name string) string    { return "/agent-abort/" + name }

// Chat is a stateful conversation with an agent.
type Chat struct {
	transport Transport
	key       string

	// stateManagement is "" until known; the first turn auto-detects it from the
	// output shape (snapshotId => server, state => client).
	stateManagement StateManagement

	snapshotID  string
	sessionID   string
	clientState json.RawMessage // raw SessionState, round-tripped for client agents

	messages []Message
}

// SnapshotID returns the current server snapshot id, or "" for a fresh or
// client-managed chat.
func (c *Chat) SnapshotID() string { return c.snapshotID }

// SessionID returns the conversation's session id once the runtime reports it.
func (c *Chat) SessionID() string { return c.sessionID }

// State returns the latest client-managed session state blob, or nil.
func (c *Chat) State() json.RawMessage { return c.clientState }

// buildInit builds the AgentInit for the next turn from tracked state. It always
// returns a valid object (an empty object is the "fresh session" init).
func (c *Chat) buildInit() json.RawMessage {
	switch {
	case c.snapshotID != "":
		b, _ := json.Marshal(map[string]string{"snapshotId": c.snapshotID})
		return b
	case len(c.clientState) > 0:
		b, _ := json.Marshal(map[string]json.RawMessage{"state": c.clientState})
		return b
	case c.sessionID != "":
		b, _ := json.Marshal(map[string]string{"sessionId": c.sessionID})
		return b
	default:
		return json.RawMessage("{}")
	}
}

// applyOutput folds a completed turn's raw AgentOutput into the tracked state
// and returns the Response.
func (c *Chat) applyOutput(raw json.RawMessage) *Response {
	var o wireOutput
	_ = json.Unmarshal(raw, &o)

	if o.SnapshotID != "" {
		c.snapshotID = o.SnapshotID
	}
	if o.SessionID != "" {
		c.sessionID = o.SessionID
	}
	if len(o.State) > 0 {
		c.clientState = o.State
	}
	// Auto-detect state ownership from the first turn if the runtime did not
	// declare it: a snapshotId means server-managed, an inline state means
	// client-managed.
	if c.stateManagement == "" {
		if o.SnapshotID != "" {
			c.stateManagement = StateServer
		} else if len(o.State) > 0 {
			c.stateManagement = StateClient
		}
	}
	// Track the running message list: authoritative state.messages replaces it;
	// otherwise append the turn's reply message.
	if len(o.State) > 0 {
		var st struct {
			Messages []Message `json:"messages"`
		}
		if json.Unmarshal(o.State, &st) == nil && st.Messages != nil {
			c.messages = st.Messages
		} else if o.Message != nil {
			c.messages = append(c.messages, *o.Message)
		}
	} else if o.Message != nil {
		c.messages = append(c.messages, *o.Message)
	}

	return &Response{
		Text:         partsText(messageContent(o.Message)),
		FinishReason: o.FinishReason,
		SnapshotID:   c.snapshotID,
		SessionID:    c.sessionID,
		SessionState: c.clientState,
		Message:      o.Message,
		Raw:          raw,
		errDetail:    o.Error,
	}
}

// Send runs a single turn and returns the completed Response. It is the
// non-streaming veneer over SendStream: it drains the stream internally (which
// keeps client-managed state live) before returning.
func (c *Chat) Send(ctx context.Context, input Input) (*Response, error) {
	turn := c.SendStream(ctx, input)
	for range turn.Chunks {
		// Drain: the state side effects happen in SendStream's goroutine.
	}
	return turn.Response()
}

// SendStream runs a single turn and returns a Turn exposing a Chunks channel and
// the eventual Response. The turn runs in the background; range over Chunks to
// consume the stream, then call Response.
func (c *Chat) SendStream(ctx context.Context, input Input) *Turn {
	// Eagerly track the user message so it is part of the running history.
	if input.Message != nil {
		c.messages = append(c.messages, *input.Message)
	}
	messageCountBeforeTurn := len(c.messages)

	inputJSON, _ := json.Marshal(input)
	init := c.buildInit()

	chunks := make(chan Chunk)
	t := &Turn{Chunks: chunks, done: make(chan struct{})}

	go func() {
		defer close(chunks)
		raw, err := c.transport.RunTurn(ctx, TurnParams{
			Key:   c.key,
			Input: inputJSON,
			Init:  init,
			OnChunk: func(rc json.RawMessage) {
				chunks <- parseChunk(rc)
			},
		})
		if err != nil {
			// Roll back the eagerly pushed user message so it is not re-sent on
			// the next turn.
			if len(c.messages) >= messageCountBeforeTurn && messageCountBeforeTurn > 0 {
				c.messages = c.messages[:messageCountBeforeTurn-1]
			}
			t.err = err
			close(t.done)
			return
		}
		resp := c.applyOutput(raw)
		t.resp = resp
		if resp.FinishReason == "failed" {
			t.err = resp.Err()
		}
		close(t.done)
	}()

	return t
}

// Input is a single agent turn's input.
type Input struct {
	Message *Message        `json:"message,omitempty"`
	Resume  json.RawMessage `json:"resume,omitempty"`
	Detach  bool            `json:"detach,omitempty"`
}

// TextInput builds an Input carrying a single user text message.
func TextInput(text string) Input {
	return Input{Message: &Message{Role: "user", Content: []Part{{Text: text}}}}
}

// Turn is a single in-flight turn: its streamed chunks plus the eventual
// Response. It is the Go analog of the JS { stream, response }.
type Turn struct {
	// Chunks yields streamed chunks; it is closed when the turn ends.
	Chunks <-chan Chunk

	done chan struct{}
	resp *Response
	err  error
}

// Response blocks until the turn completes and returns its result. A failed turn
// returns a non-nil error (an *AgentError). Safe to call after draining Chunks.
func (t *Turn) Response() (*Response, error) {
	<-t.done
	if t.err != nil {
		return t.resp, t.err
	}
	return t.resp, nil
}

// Response is the completed result of a turn.
type Response struct {
	// Text is the concatenated text of the reply message.
	Text string
	// FinishReason is why the turn ended (e.g. "stop", "interrupted", "failed").
	FinishReason string
	// SnapshotID is the server snapshot id after this turn (server-managed).
	SnapshotID string
	// SessionID correlates the snapshots/turns of this conversation.
	SessionID string
	// SessionState is the raw SessionState blob (client-managed agents). Round-
	// trip it into the next chat via WithState, or let the same Chat do it.
	SessionState json.RawMessage
	// Message is the raw reply message.
	Message *Message
	// Raw is the full AgentOutput JSON.
	Raw json.RawMessage

	errDetail *RuntimeError
}

// Err returns an *AgentError when the turn failed, or nil otherwise.
func (r *Response) Err() error {
	if r == nil || r.FinishReason != "failed" {
		return nil
	}
	msg := "agent turn failed"
	status := "UNKNOWN"
	if r.errDetail != nil {
		if r.errDetail.Message != "" {
			msg = r.errDetail.Message
		}
		if r.errDetail.Status != "" {
			status = r.errDetail.Status
		}
	}
	return &AgentError{Status: status, Message: msg, SnapshotID: r.SnapshotID}
}

// Chunk is a streamed chunk of a turn.
type Chunk struct {
	// Text is the incremental text carried by this chunk (may be empty).
	Text string
	// Raw is the full AgentStreamChunk JSON.
	Raw json.RawMessage
}

// AgentError is returned when a turn ends with finishReason "failed". It carries
// the last-good snapshot id so the session stays recoverable.
type AgentError struct {
	Status     string
	Message    string
	SnapshotID string
}

func (e *AgentError) Error() string {
	if e.Status != "" {
		return fmt.Sprintf("%s: %s", e.Status, e.Message)
	}
	return e.Message
}

// ── wire helpers ───────────────────────────────────────────────────────────

// Media is a media part's payload.
type Media struct {
	URL         string `json:"url"`
	ContentType string `json:"contentType,omitempty"`
}

// Part is one part of a message's content.
type Part struct {
	Text         string          `json:"text,omitempty"`
	Reasoning    *string         `json:"reasoning,omitempty"`
	Media        *Media          `json:"media,omitempty"`
	Data         json.RawMessage `json:"data,omitempty"`
	ToolRequest  json.RawMessage `json:"toolRequest,omitempty"`
	ToolResponse json.RawMessage `json:"toolResponse,omitempty"`
	Metadata     json.RawMessage `json:"metadata,omitempty"`
}

// Message is a chat message.
type Message struct {
	Role     string          `json:"role"`
	Content  []Part          `json:"content"`
	Metadata json.RawMessage `json:"metadata,omitempty"`
}

// RuntimeError is the structured error carried in a failed AgentOutput.
type RuntimeError struct {
	Status  string          `json:"status,omitempty"`
	Message string          `json:"message"`
	Details json.RawMessage `json:"details,omitempty"`
}

type wireOutput struct {
	SessionID    string          `json:"sessionId,omitempty"`
	SnapshotID   string          `json:"snapshotId,omitempty"`
	State        json.RawMessage `json:"state,omitempty"`
	Message      *Message        `json:"message,omitempty"`
	FinishReason string          `json:"finishReason,omitempty"`
	Error        *RuntimeError   `json:"error,omitempty"`
}

func parseChunk(raw json.RawMessage) Chunk {
	var wc struct {
		ModelChunk *struct {
			Content []Part `json:"content"`
		} `json:"modelChunk,omitempty"`
	}
	_ = json.Unmarshal(raw, &wc)
	text := ""
	if wc.ModelChunk != nil {
		text = partsText(wc.ModelChunk.Content)
	}
	return Chunk{Text: text, Raw: raw}
}

func messageContent(m *Message) []Part {
	if m == nil {
		return nil
	}
	return m.Content
}

func partsText(parts []Part) string {
	var b strings.Builder
	for _, p := range parts {
		b.WriteString(p.Text)
	}
	return b.String()
}

func isJSONNull(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s == "" || s == "null"
}
