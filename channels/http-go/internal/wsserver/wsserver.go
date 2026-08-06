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

// Package wsserver is a tiny, dependency-free RFC 6455 WebSocket server. It
// implements only the server half of the handshake and the text/binary/close
// frame handling that the reflection v2 link needs. Keeping this in the stdlib
// is what lets the Go channel compile to a small static binary with no third
// party modules.
package wsserver

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

// magicGUID is the RFC 6455 handshake constant.
const magicGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// opcodes we care about.
const (
	opText   = 0x1
	opBinary = 0x2
	opClose  = 0x8
	opPing   = 0x9
	opPong   = 0xA
)

// Conn is an accepted WebSocket connection. It is safe to call WriteText from
// multiple goroutines; a mutex serializes frame writes.
type Conn struct {
	conn net.Conn
	br   *bufio.Reader
	wmu  sync.Mutex
}

// Upgrade performs the server-side handshake on an http.ResponseWriter that
// supports hijacking. On success it returns a Conn ready for ReadMessage /
// WriteText.
func Upgrade(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, errors.New("not a websocket upgrade request")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key")
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("response writer does not support hijacking")
	}
	conn, buf, err := hj.Hijack()
	if err != nil {
		return nil, err
	}

	accept := computeAcceptKey(key)
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := buf.WriteString(resp); err != nil {
		conn.Close()
		return nil, err
	}
	if err := buf.Flush(); err != nil {
		conn.Close()
		return nil, err
	}
	return &Conn{conn: conn, br: buf.Reader}, nil
}

func computeAcceptKey(key string) string {
	h := sha1.New()
	io.WriteString(h, key+magicGUID)
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// ReadMessage reads a single complete text or binary message, transparently
// answering pings and handling close. It returns io.EOF when the peer closes.
func (c *Conn) ReadMessage() ([]byte, error) {
	var message []byte
	var msgOpcode byte
	for {
		fin, opcode, payload, err := c.readFrame()
		if err != nil {
			return nil, err
		}
		switch opcode {
		case opClose:
			c.writeFrame(opClose, nil)
			return nil, io.EOF
		case opPing:
			c.writeFrame(opPong, payload)
			continue
		case opPong:
			continue
		case opText, opBinary:
			msgOpcode = opcode
			message = append(message, payload...)
		case 0x0: // continuation
			message = append(message, payload...)
		default:
			return nil, fmt.Errorf("unsupported opcode 0x%x", opcode)
		}
		if fin && (msgOpcode == opText || msgOpcode == opBinary) {
			return message, nil
		}
	}
}

// readFrame reads one frame. Client frames are always masked per RFC 6455.
func (c *Conn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(c.br, hdr[:]); err != nil {
		return
	}
	fin = hdr[0]&0x80 != 0
	opcode = hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7f)

	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = binary.BigEndian.Uint64(ext[:])
	}

	var maskKey [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, maskKey[:]); err != nil {
			return
		}
	}

	payload = make([]byte, length)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return
}

// WriteText sends a text message as a single unmasked frame (server-to-client
// frames are never masked).
func (c *Conn) WriteText(data []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return c.writeFrame(opText, data)
}

func (c *Conn) writeFrame(opcode byte, data []byte) error {
	var header []byte
	b0 := byte(0x80) | opcode // FIN + opcode
	length := len(data)
	switch {
	case length < 126:
		header = []byte{b0, byte(length)}
	case length < 65536:
		header = []byte{b0, 126, byte(length >> 8), byte(length)}
	default:
		header = make([]byte, 10)
		header[0] = b0
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:], uint64(length))
	}
	if _, err := c.conn.Write(header); err != nil {
		return err
	}
	if len(data) > 0 {
		if _, err := c.conn.Write(data); err != nil {
			return err
		}
	}
	return nil
}

// Close tears down the underlying TCP connection.
func (c *Conn) Close() error {
	return c.conn.Close()
}
