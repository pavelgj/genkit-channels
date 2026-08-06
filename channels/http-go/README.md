# http-go channel

The Go implementation of the HTTP channel. It does the same job as the Node
`channels/http` channel: run the user's Genkit app as a headless child process,
discover its actions over reflection v2, and expose each flow/agent as an HTTP
endpoint. No codegen, no import of user code; routing is built at runtime from
`listActions`, so the same channel works against a JS, Go, or Python app.

The reason this exists alongside the Node channel is footprint. It compiles to a
single static binary with **no third-party modules** (the WebSocket server half
and JSON-RPC correlation are implemented on the Go standard library), so it
cold-starts faster and idles at a fraction of the memory. See
[../../docs/BENCHMARKS.md](../../docs/BENCHMARKS.md) for measured numbers.

## Layout

```
http-go/
  main.go                       HTTP transport: routes discovered actions
  internal/appproc/             the startAppProcess equivalent (server half of
                                reflection v2: config loading, spawn child,
                                register, runAction, Config/ListAgents/GetAgent)
  internal/agent/               the agent-client equivalent (drive an agent's
                                chat over reflection v2)
  internal/wsserver/            tiny stdlib RFC 6455 WebSocket server
  channel.yaml                  channel manifest (compiled: entry is the binary)
```

## Helper surface (`internal/appproc`)

The Go helper mirrors the Node `startAppProcess` surface, so a Go channel writes
almost no plumbing. `Start()` is self-configuring: with no arguments it reads
`channel.config.json` (path via `GENKIT_CHANNEL_CONFIG` or
`./channel.config.json`, with `child.cwd` resolved relative to the file), decides
managed vs attached mode, and begins listening/spawning. `Start` is variadic and
returns an error, following Go convention for immediate bind failures:

```go
app, err := appproc.Start()             // self-configures from channel.config.json
cfg := app.Config()                     // { Expose, Options }

var opts MyOptions
_ = cfg.UnmarshalOptions(&opts)         // decode the deployment's `with` block

actions, err := app.ListActions(ctx)    // waits for readiness internally
agents, err := app.ListAgents(ctx)      // discovery + capability metadata
```

An HTTP transport channel like this one only needs `Config().Expose`,
`ListActions`, and `RunAction`. A chat channel (Discord/Slack, etc.) uses the
agent client instead:

```go
agent, err := app.GetAgent(ctx)         // sole exposed agent, or pass a name
chat := agent.Chat(agent.WithSession(sessionID))
turn := chat.SendStream(ctx, agent.TextInput("hello"))
for chunk := range turn.Chunks {
    fmt.Print(chunk.Text)
}
res, err := turn.Response()
```

`GetAgent` picks the exposed agent (or the single discovered one), and the
returned client tracks session state across turns (the server `snapshotId` or the
client-managed state blob) so callers do not thread it by hand.


## Build and run

```bash
go build -o bin/http-go-channel .

# Point it at a headless app via channel.config.json (same schema the CLI writes)
cat > channel.config.json <<'JSON'
{
  "child": { "command": "./bin/app", "args": [], "cwd": "." },
  "expose": { "agents": [], "flows": [] },
  "config": {},
  "readyTimeoutMs": 30000
}
JSON

PORT=8080 GENKIT_CHANNEL_CONFIG=./channel.config.json ./bin/http-go-channel
```

Then:

```bash
curl localhost:8080/                       # lists endpoints
curl -X POST localhost:8080/<flow> -d '{"data":{...}}'
curl -X POST "localhost:8080/<flow>?stream=1" -d '{"data":{...}}'
```

## Relationship to the Node channel

Feature parity with `channels/http`: discovery, the `expose` filter, non-stream
and streamed `runAction`, cancel-on-disconnect, and graceful `SIGTERM`
forwarding to the child. The wire behavior is identical, so a client cannot tell
which one it is talking to. The difference is purely operational (size, cold
start, memory).
