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

// Package appproc is the Go equivalent of the Node startAppProcess helper: the
// server half of reflection v2. It opens a WebSocket server on an ephemeral
// loopback port, spawns the user's app as a child with
// GENKIT_REFLECTION_V2_SERVER set, waits for the child to register, and exposes
// listActions / runAction / cancelAction over the JSON-RPC 2.0 link.
//
// A channel usually needs to write almost no plumbing. Start() is
// self-configuring: with no options it reads the framework's channel.config.json
// (path + child.cwd resolution owned by the package), decides managed vs
// attached mode, and begins listening/spawning. The channel then reads Config(),
// waits for readiness (ListActions/ListAgents do it for you), and drives the
// discovered actions or agents:
//
//	app, err := appproc.Start()
//	cfg := app.Config()                    // { Expose, Options }
//	agent, err := app.GetAgent(ctx)        // discover + build an agent client
//	chat := agent.Chat(agent.WithSession(sessionID))
package appproc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"genkit-channels-http-go/internal/agent"
	"genkit-channels-http-go/internal/wsserver"
)

// ChildSpec describes how to launch the user's app.
type ChildSpec struct {
	Command string
	Args    []string
	Cwd     string
	Env     map[string]string
}

// Options configure an AppProcess.
//
// All fields are optional. When Start is called with no Options (or a zero
// Options), the values are derived from channel.config.json. Explicit fields
// win over the config file.
type Options struct {
	// Child, when set, is spawned (managed mode). When nil, the AppProcess waits
	// for a sidecar to dial in (attached mode).
	Child        *ChildSpec
	ReadyTimeout time.Duration
	Host         string
	// Port, when non-zero, binds the reflection v2 WS server to a fixed port
	// (attached mode, so a sidecar can dial a known address). Zero uses an
	// ephemeral port (managed mode).
	Port int
	// LoadConfig controls whether channel.config.json is read to fill unset
	// fields (and Config()). It defaults to true; set it to false to opt out
	// (e.g. tests that pass an explicit Child/Port and have no config file).
	LoadConfig *bool

	// expose/options are populated from channel.config.json for Config().
	expose  Expose
	options json.RawMessage
}

// Expose is the deployment's resolved filter: which discovered actions to serve.
type Expose struct {
	Agents []string `json:"agents"`
	Flows  []string `json:"flows"`
}

// Config is the channel's view of its composed configuration.
type Config struct {
	// Expose is the resolved expose filter (which agents/flows to serve).
	Expose Expose
	// Options is the channel-specific options block (the deployment's `with`).
	Options json.RawMessage
}

// UnmarshalOptions decodes the channel-specific options block into a struct.
func (c Config) UnmarshalOptions(v interface{}) error {
	if len(c.Options) == 0 {
		return nil
	}
	return json.Unmarshal(c.Options, v)
}

// rawChannelConfig mirrors channel.config.json written by the CLI.
type rawChannelConfig struct {
	Child *struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
		Cwd     string   `json:"cwd"`
	} `json:"child"`
	Attach *struct {
		Port int    `json:"port"`
		Host string `json:"host"`
	} `json:"attach"`
	Expose         Expose          `json:"expose"`
	Config         json.RawMessage `json:"config"`
	ReadyTimeoutMs int             `json:"readyTimeoutMs"`
}

// loadChannelConfigFile reads and normalizes channel.config.json. The path is
// GENKIT_CHANNEL_CONFIG or ./channel.config.json; child.cwd is resolved relative
// to the config file so the same config works locally and in-image. Returns an
// empty config when the file is missing or unreadable.
func loadChannelConfigFile() rawChannelConfig {
	configPath := os.Getenv("GENKIT_CHANNEL_CONFIG")
	if configPath == "" {
		configPath = "./channel.config.json"
	}
	abs, _ := filepath.Abs(configPath)
	baseDir := filepath.Dir(abs)

	var cfg rawChannelConfig
	data, err := os.ReadFile(abs)
	if err != nil {
		return cfg
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		fmt.Fprintf(os.Stderr, "[channel:http-go] failed to read %s: %v\n", abs, err)
		return rawChannelConfig{}
	}
	// Resolve the child cwd relative to the config file, like the Node channel.
	if cfg.Child != nil && cfg.Child.Cwd != "" && !filepath.IsAbs(cfg.Child.Cwd) {
		cfg.Child.Cwd = filepath.Join(baseDir, cfg.Child.Cwd)
	}
	return cfg
}

// rpcMessage is a JSON-RPC 2.0 envelope (request, response, or notification).
type rpcMessage struct {
	JSONRPC string           `json:"jsonrpc,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
	Result  json.RawMessage  `json:"result,omitempty"`
	Error   *rpcError        `json:"error,omitempty"`
	ID      *json.RawMessage `json:"id,omitempty"`
}

type rpcError struct {
	Message string          `json:"message,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// RunActionResult is the envelope returned by RunAction.
type RunActionResult struct {
	Result    json.RawMessage `json:"result"`
	Telemetry *struct {
		TraceID string `json:"traceId"`
	} `json:"telemetry,omitempty"`
}

// RunActionParams configure a single runAction call.
type RunActionParams struct {
	Key       string
	Input     json.RawMessage
	Context   json.RawMessage
	OnChunk   func(chunk json.RawMessage)
	OnTraceID func(traceID string)
}

type pending struct {
	ch chan rpcMessage
}

// AppProcess is the server half of the reflection v2 link.
type AppProcess struct {
	opts         Options
	host         string
	readyTimeout time.Duration
	config       Config

	httpServer *http.Server
	listener   net.Listener
	port       int

	conn   *wsserver.Conn
	connMu sync.Mutex

	cmd        *exec.Cmd
	registered bool

	reqID   int64
	reqMu   sync.Mutex
	pending map[string]*pending
	streams map[string]func(json.RawMessage)
	traces  map[string]func(string)
	cbMu    sync.Mutex

	readyCh   chan struct{}
	readyOnce sync.Once
	readyErr  error
}

// Start opens the WS server and (in managed mode) spawns the child.
//
// Start is variadic so the common case is a zero-argument call:
//
//	app, err := appproc.Start()
//
// With no Options (or a zero Options) it self-configures from
// channel.config.json: it reads the child spawn spec (managed mode) or attach
// port (attached mode), the ready timeout, and the expose/options for Config().
// Any field set on an explicit Options wins over the config file. Pass at most
// one Options.
func Start(opts ...Options) (*AppProcess, error) {
	var o Options
	if len(opts) > 0 {
		o = opts[0]
	}

	// Fill unset fields from channel.config.json unless explicitly opted out.
	if o.LoadConfig == nil || *o.LoadConfig {
		file := loadChannelConfigFile()
		o.expose = file.Expose
		o.options = file.Config
		if o.Child == nil && file.Child != nil && file.Child.Command != "" {
			o.Child = &ChildSpec{
				Command: file.Child.Command,
				Args:    file.Child.Args,
				Cwd:     file.Child.Cwd,
			}
		}
		// Attached mode: no child, bind the fixed port the sidecar dials.
		if o.Child == nil && o.Port == 0 && file.Attach != nil {
			o.Port = file.Attach.Port
			if o.Host == "" {
				o.Host = file.Attach.Host
			}
		}
		if o.ReadyTimeout == 0 && file.ReadyTimeoutMs > 0 {
			o.ReadyTimeout = time.Duration(file.ReadyTimeoutMs) * time.Millisecond
		}
	}

	host := o.Host
	if host == "" {
		host = "127.0.0.1"
	}
	readyTimeout := o.ReadyTimeout
	if readyTimeout == 0 {
		readyTimeout = 30 * time.Second
	}
	a := &AppProcess{
		opts:         o,
		host:         host,
		readyTimeout: readyTimeout,
		config:       Config{Expose: o.expose, Options: o.options},
		pending:      make(map[string]*pending),
		streams:      make(map[string]func(json.RawMessage)),
		traces:       make(map[string]func(string)),
		readyCh:      make(chan struct{}),
	}
	if err := a.listen(); err != nil {
		return nil, err
	}
	if o.Child != nil && o.Child.Command != "" {
		if err := a.spawnChild(o.Child); err != nil {
			return nil, err
		}
	}
	return a, nil
}

// Config returns the channel's composed configuration: the resolved expose
// filter and the channel-specific options block (the deployment's `with`),
// loaded from channel.config.json at Start.
func (a *AppProcess) Config() Config {
	return a.config
}

// Attached reports whether the process is in attached (sidecar) mode: no child
// was spawned and it waits for a runtime to dial the fixed port.
func (a *AppProcess) Attached() bool {
	return a.opts.Child == nil
}

func (a *AppProcess) listen() error {
	// A fixed port (attached mode) lets a sidecar dial a known address; port 0
	// lets the OS pick a free ephemeral port (managed mode).
	portStr := "0"
	if a.opts.Port != 0 {
		portStr = strconv.Itoa(a.opts.Port)
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(a.host, portStr))
	if err != nil {
		return err
	}

	a.listener = ln
	a.port = ln.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	mux.HandleFunc("/", a.handleWS)
	a.httpServer = &http.Server{Handler: mux}
	go a.httpServer.Serve(ln)
	return nil
}

// WSURL is the ws:// address the child should dial.
func (a *AppProcess) WSURL() string {
	return fmt.Sprintf("ws://%s:%d", a.host, a.port)
}

func (a *AppProcess) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := wsserver.Upgrade(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	a.connMu.Lock()
	a.conn = conn
	a.connMu.Unlock()

	for {
		data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		a.onMessage(data)
	}
}

func (a *AppProcess) spawnChild(child *ChildSpec) error {
	cmd := exec.Command(child.Command, child.Args...)
	cmd.Dir = child.Cwd
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	env := os.Environ()
	for k, v := range child.Env {
		env = append(env, k+"="+v)
	}
	env = append(env, "GENKIT_REFLECTION_V2_SERVER="+a.WSURL())
	// The reflection v2 client only activates in dev mode in the runtimes today.
	if _, ok := child.Env["GENKIT_ENV"]; !ok {
		env = append(env, "GENKIT_ENV=dev")
	}
	// The channel owns the public $PORT; keep it away from the headless child.
	filtered := env[:0]
	for _, e := range env {
		if len(e) >= 5 && e[:5] == "PORT=" {
			continue
		}
		filtered = append(filtered, e)
	}
	cmd.Env = filtered

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start child process: %w", err)
	}
	a.cmd = cmd
	go func() {
		err := cmd.Wait()
		if !a.registered {
			a.failReady(fmt.Errorf("child process exited before registering: %v", err))
		} else if err != nil {
			fmt.Fprintf(os.Stderr, "[channel:http-go] child exited: %v\n", err)
			os.Exit(1)
		}
	}()
	return nil
}

// Ready blocks until the child has connected and registered, or the timeout
// elapses.
func (a *AppProcess) Ready() error {
	select {
	case <-a.readyCh:
		return a.readyErr
	case <-time.After(a.readyTimeout):
		return fmt.Errorf("timed out after %s waiting for the runtime to register", a.readyTimeout)
	}
}

func (a *AppProcess) resolveReady() {
	a.readyOnce.Do(func() { close(a.readyCh) })
}

func (a *AppProcess) failReady(err error) {
	a.readyOnce.Do(func() {
		a.readyErr = err
		close(a.readyCh)
	})
}

func (a *AppProcess) onMessage(data []byte) {
	var msg rpcMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		fmt.Fprintf(os.Stderr, "[channel:http-go] bad message: %v\n", err)
		return
	}
	if msg.Method != "" {
		a.onRequestOrNotification(&msg)
		return
	}
	if msg.ID != nil {
		a.onResponse(&msg)
	}
}

func (a *AppProcess) onRequestOrNotification(msg *rpcMessage) {
	switch msg.Method {
	case "register":
		a.registered = true
		if msg.ID != nil {
			a.send(rpcMessage{JSONRPC: "2.0", Result: json.RawMessage("{}"), ID: msg.ID})
		}
		a.resolveReady()
	case "streamChunk":
		var p struct {
			RequestID json.RawMessage `json:"requestId"`
			Chunk     json.RawMessage `json:"chunk"`
		}
		if err := json.Unmarshal(msg.Params, &p); err == nil {
			id := rawToString(p.RequestID)
			a.cbMu.Lock()
			cb := a.streams[id]
			a.cbMu.Unlock()
			if cb != nil {
				cb(p.Chunk)
			}
		}
	case "runActionState":
		var p struct {
			RequestID json.RawMessage `json:"requestId"`
			State     struct {
				TraceID string `json:"traceId"`
			} `json:"state"`
		}
		if err := json.Unmarshal(msg.Params, &p); err == nil && p.State.TraceID != "" {
			id := rawToString(p.RequestID)
			a.cbMu.Lock()
			cb := a.traces[id]
			a.cbMu.Unlock()
			if cb != nil {
				cb(p.State.TraceID)
			}
		}
	}
}

func (a *AppProcess) onResponse(msg *rpcMessage) {
	id := rawToString(*msg.ID)
	a.reqMu.Lock()
	p := a.pending[id]
	delete(a.pending, id)
	a.reqMu.Unlock()
	if p != nil {
		p.ch <- *msg
	}
}

func (a *AppProcess) send(msg rpcMessage) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	a.connMu.Lock()
	conn := a.conn
	a.connMu.Unlock()
	if conn == nil {
		return errors.New("no active connection")
	}
	return conn.WriteText(b)
}

func (a *AppProcess) request(ctx context.Context, method string, params interface{}, onChunk func(json.RawMessage), onTraceID func(string)) (rpcMessage, error) {
	a.reqMu.Lock()
	a.reqID++
	id := strconv.FormatInt(a.reqID, 10)
	a.reqMu.Unlock()

	p := &pending{ch: make(chan rpcMessage, 1)}
	a.reqMu.Lock()
	a.pending[id] = p
	a.reqMu.Unlock()

	if onChunk != nil || onTraceID != nil {
		a.cbMu.Lock()
		if onChunk != nil {
			a.streams[id] = onChunk
		}
		if onTraceID != nil {
			a.traces[id] = onTraceID
		}
		a.cbMu.Unlock()
	}
	defer func() {
		a.cbMu.Lock()
		delete(a.streams, id)
		delete(a.traces, id)
		a.cbMu.Unlock()
	}()

	var rawParams json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return rpcMessage{}, err
		}
		rawParams = b
	}
	idRaw := json.RawMessage(strconv.Quote(id))
	if err := a.send(rpcMessage{JSONRPC: "2.0", Method: method, Params: rawParams, ID: &idRaw}); err != nil {
		return rpcMessage{}, err
	}

	select {
	case resp := <-p.ch:
		if resp.Error != nil {
			return rpcMessage{}, fmt.Errorf("%s", resp.Error.Message)
		}
		return resp, nil
	case <-ctx.Done():
		a.reqMu.Lock()
		delete(a.pending, id)
		a.reqMu.Unlock()
		return rpcMessage{}, ctx.Err()
	}
}

// ListActions returns the map of action key -> raw action metadata. It waits for
// readiness (the child to connect and register) before issuing the call.
func (a *AppProcess) ListActions(ctx context.Context) (map[string]json.RawMessage, error) {
	if err := a.Ready(); err != nil {
		return nil, err
	}
	resp, err := a.request(ctx, "listActions", nil, nil, nil)
	if err != nil {
		return nil, err
	}
	var out struct {
		Actions map[string]json.RawMessage `json:"actions"`
	}
	if err := json.Unmarshal(resp.Result, &out); err != nil {
		return nil, err
	}
	if out.Actions == nil {
		out.Actions = map[string]json.RawMessage{}
	}
	return out.Actions, nil
}

// ListAgents lists the agents the app exposes, with the capability metadata a
// channel needs to drive them. It waits for readiness.
func (a *AppProcess) ListAgents(ctx context.Context) ([]agent.DiscoveredAgent, error) {
	actions, err := a.ListActions(ctx)
	if err != nil {
		return nil, err
	}
	return agent.DiscoverAgents(actions), nil
}

// GetAgent resolves an ergonomic agent client for one of the app's agents. Pass
// a short name (weatherAgent) or a full key (/agent/weatherAgent); with no
// argument the sole exposed agent is used (erroring on zero or many). It waits
// for readiness.
func (a *AppProcess) GetAgent(ctx context.Context, nameOrKey ...string) (*agent.API, error) {
	agents, err := a.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	want := ""
	if len(nameOrKey) > 0 {
		want = nameOrKey[0]
	}
	selected, err := selectAgent(agents, want)
	if err != nil {
		return nil, err
	}
	return agent.New(a, agent.Options{
		Key:             selected.Key,
		StateManagement: selected.StateManagement,
	}), nil
}

// selectAgent chooses a discovered agent by short name or /agent/<name> key.
// With no nameOrKey it requires exactly one agent.
func selectAgent(agents []agent.DiscoveredAgent, nameOrKey string) (agent.DiscoveredAgent, error) {
	if nameOrKey != "" {
		key := nameOrKey
		if !strings.HasPrefix(key, "/agent/") {
			key = "/agent/" + nameOrKey
		}
		for _, ag := range agents {
			if ag.Key == key || ag.Name == nameOrKey {
				return ag, nil
			}
		}
		return agent.DiscoveredAgent{}, fmt.Errorf("agent %q not found among discovered agents: %s", nameOrKey, agentNames(agents))
	}
	switch len(agents) {
	case 1:
		return agents[0], nil
	case 0:
		return agent.DiscoveredAgent{}, errors.New("no agents discovered; this channel needs an agent (define one with ai.defineAgent and expose it)")
	default:
		return agent.DiscoveredAgent{}, fmt.Errorf("multiple agents discovered (%s); pass a name to GetAgent to pick one", agentNames(agents))
	}
}

func agentNames(agents []agent.DiscoveredAgent) string {
	if len(agents) == 0 {
		return "(none)"
	}
	names := make([]string, len(agents))
	for i, ag := range agents {
		names[i] = ag.Name
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// RunTurn implements agent.Transport: it runs an agent turn as a streaming
// runAction, forwarding each AgentStreamChunk to params.OnChunk and returning
// the final AgentOutput.
func (a *AppProcess) RunTurn(ctx context.Context, params agent.TurnParams) (json.RawMessage, error) {
	body := map[string]interface{}{
		"key":    params.Key,
		"input":  params.Input,
		"init":   params.Init,
		"stream": params.OnChunk != nil,
	}
	resp, err := a.request(ctx, "runAction", body, params.OnChunk, params.OnTraceID)
	if err != nil {
		return nil, err
	}
	return resp.Result, nil
}

// Run implements agent.Transport: it runs a plain (non-streaming) action, such
// as the getSnapshot / abort companions, and returns its result.
func (a *AppProcess) Run(ctx context.Context, key string, input json.RawMessage) (json.RawMessage, error) {
	res, err := a.RunAction(ctx, RunActionParams{Key: key, Input: input})
	if err != nil {
		return nil, err
	}
	return res.Result, nil
}

// RunAction runs an action, optionally streaming chunks via OnChunk.
func (a *AppProcess) RunAction(ctx context.Context, params RunActionParams) (RunActionResult, error) {
	body := map[string]interface{}{
		"key":    params.Key,
		"input":  params.Input,
		"stream": params.OnChunk != nil,
	}
	if params.Context != nil {
		body["context"] = params.Context
	}
	resp, err := a.request(ctx, "runAction", body, params.OnChunk, params.OnTraceID)
	if err != nil {
		return RunActionResult{}, err
	}
	var res RunActionResult
	if err := json.Unmarshal(resp.Result, &res); err != nil {
		return RunActionResult{}, err
	}
	return res, nil
}

// CancelAction cancels an in-flight action by trace id (best effort).
func (a *AppProcess) CancelAction(traceID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = a.request(ctx, "cancelAction", map[string]string{"traceId": traceID}, nil, nil)
}

// Stop forwards a signal to the child and closes the server.
func (a *AppProcess) Stop() {
	if a.httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = a.httpServer.Shutdown(ctx)
	}
	if a.cmd != nil && a.cmd.Process != nil {
		_ = a.cmd.Process.Signal(os.Interrupt)
	}
}

// rawToString turns a JSON-RPC id (which may be a quoted string or a number)
// into a stable map key.
func rawToString(raw json.RawMessage) string {
	s := string(raw)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		unquoted, err := strconv.Unquote(s)
		if err == nil {
			return unquoted
		}
	}
	return s
}
