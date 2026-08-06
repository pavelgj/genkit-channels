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

// Command http-go is the Go implementation of the HTTP channel. It runs the
// user's Genkit app as a child process, discovers its actions over reflection
// v2, and exposes each flow/agent as an HTTP endpoint. There is no codegen and
// no import of user code: routing is built at runtime from listActions, so the
// same channel works against a JS, Go, or Python app.
//
// This is the Go counterpart of channels/http (Node). It compiles to a small,
// dependency-free static binary, which is the point of the exercise: measure
// how much lighter a Go channel is versus the Node one.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"genkit-channels-http-go/internal/appproc"
)

type route struct {
	kind string
	name string
	path string
	key  string
}

var actionKeyRe = regexp.MustCompile(`^/(flow|agent)/(.+)$`)

func routeForAction(key string) *route {
	m := actionKeyRe.FindStringSubmatch(key)
	if m == nil {
		return nil
	}
	return &route{kind: m[1], name: m[2], path: "/" + m[2], key: key}
}

func shouldExpose(r *route, agents, flows []string) bool {
	if len(agents) == 0 && len(flows) == 0 {
		return true
	}
	if r.kind == "agent" {
		return contains(agents, r.name)
	}
	return contains(flows, r.name)
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func main() {
	// The framework reads channel.config.json for us: managed vs attached mode,
	// how to spawn the child, the ready timeout, and the expose filter.
	app, err := appproc.Start()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[channel:http-go] %v\n", err)
		os.Exit(1)
	}
	expose := app.Config().Expose
	attached := app.Attached()

	// Readiness gate. Start the HTTP ingress immediately (so the platform's
	// startup probe and container ordering work in sidecar mode), but serve 503
	// until the app has registered and its actions are discovered. Routes are
	// published atomically once ready.
	var ready atomic.Bool
	var routeMap atomic.Value // map[string]route
	routeMap.Store(map[string]route{})

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		routes, _ := routeMap.Load().(map[string]route)
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "application/json")
			if !ready.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
				json.NewEncoder(w).Encode(map[string]interface{}{"status": "starting"})
				return
			}
			eps := make([]map[string]string, 0, len(routes))
			for _, rt := range routes {
				eps = append(eps, map[string]string{"path": rt.path, "kind": rt.kind})
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok", "endpoints": eps})
			return
		}
		if !ready.Load() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"error":{"message":"channel starting up"}}`))
			return
		}
		rt, ok := routes[r.URL.Path]
		if !ok || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		handleAction(w, r, app, rt)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := &http.Server{Addr: ":" + port, Handler: mux}

	go func() {
		fmt.Printf("[channel:http-go] listening on :%s (%s mode; waiting for app to register)\n",
			port, modeName(attached))
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "[channel:http-go] server error: %v\n", err)
			os.Exit(1)
		}
	}()

	// Wait for the app to connect + register, then discover actions and publish
	// the routes.
	if err := app.Ready(); err != nil {
		fmt.Fprintf(os.Stderr, "[channel:http-go] %v\n", err)
		app.Stop()
		os.Exit(1)
	}
	ctx := context.Background()
	actions, err := app.ListActions(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[channel:http-go] listActions failed: %v\n", err)
		app.Stop()
		os.Exit(1)
	}

	keys := make([]string, 0, len(actions))
	for k := range actions {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	routes := make(map[string]route)
	for _, key := range keys {
		if r := routeForAction(key); r != nil && shouldExpose(r, expose.Agents, expose.Flows) {

			routes[r.path] = *r
		}
	}
	routeMap.Store(routes)
	ready.Store(true)
	fmt.Printf("[channel:http-go] ready (%d endpoint(s))\n", len(routes))
	for _, rt := range routes {
		fmt.Printf("  POST %s  -> %s\n", rt.path, rt.key)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	s := <-sig
	fmt.Printf("[channel:http-go] %v received, shutting down\n", s)
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(shutCtx)
	app.Stop()
}

func modeName(attached bool) string {
	if attached {
		return "attached"
	}
	return "managed"
}

func handleAction(w http.ResponseWriter, r *http.Request, app *appproc.AppProcess, rt route) {
	wantStream := r.URL.Query().Get("stream") == "true" || r.URL.Query().Get("stream") == "1"

	var body map[string]json.RawMessage
	dec := json.NewDecoder(r.Body)
	_ = dec.Decode(&body)
	var input json.RawMessage
	if body != nil {
		if d, ok := body["data"]; ok {
			input = d
		} else if raw, err := json.Marshal(body); err == nil {
			input = raw
		}
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	var traceID string
	onTrace := func(tid string) { traceID = tid }

	if wantStream {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		flusher, _ := w.(http.Flusher)
		res, err := app.RunAction(ctx, appproc.RunActionParams{
			Key:   rt.key,
			Input: input,
			OnChunk: func(chunk json.RawMessage) {
				w.Write(chunk)
				w.Write([]byte("\n"))
				if flusher != nil {
					flusher.Flush()
				}
			},
			OnTraceID: onTrace,
		})
		if err != nil {
			if traceID != "" {
				app.CancelAction(traceID)
			}
			w.Write([]byte(`{"error":{"message":` + strconv.Quote(err.Error()) + `}}` + "\n"))
			return
		}
		final, _ := json.Marshal(map[string]json.RawMessage{"result": res.Result})
		w.Write(final)
		w.Write([]byte("\n"))
		return
	}

	res, err := app.RunAction(ctx, appproc.RunActionParams{Key: rt.key, Input: input, OnTraceID: onTrace})
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":{"message":` + strconv.Quote(err.Error()) + `}}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	out, _ := json.Marshal(map[string]json.RawMessage{"result": res.Result})
	w.Write(out)
}
