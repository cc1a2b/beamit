package signaling

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer (1MB).
	maxMessageSize = 1 << 20

	// Send buffer size.
	sendBufferSize = 256
)

// Peer represents a connected WebSocket client.
type Peer struct {
	ID         string
	Name       string
	DeviceType string
	PublicIP   string
	RoomCode   string
	Conn       *websocket.Conn
	Send       chan []byte
	Hub        *Hub
	JoinedAt   time.Time

	closeOnce sync.Once
}

// NewPeer creates a new Peer with a unique ID.
func NewPeer(conn *websocket.Conn, hub *Hub, publicIP string) (*Peer, error) {
	id, err := generatePeerID()
	if err != nil {
		return nil, fmt.Errorf("generating peer ID: %w", err)
	}

	return &Peer{
		ID:       id,
		Conn:     conn,
		Send:     make(chan []byte, sendBufferSize),
		Hub:      hub,
		PublicIP: publicIP,
		JoinedAt: time.Now(),
	}, nil
}

// Info returns a PeerInfo snapshot.
func (p *Peer) Info() PeerInfo {
	return PeerInfo{
		ID:         p.ID,
		Name:       p.Name,
		DeviceType: p.DeviceType,
	}
}

// ReadPump pumps messages from the WebSocket connection to the hub.
// Runs in its own goroutine per peer.
func (p *Peer) ReadPump() {
	defer func() {
		p.Hub.Unregister <- p
		p.Close()
	}()

	p.Conn.SetReadLimit(maxMessageSize)
	if err := p.Conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		slog.Error("failed to set read deadline", "peer", p.ID, "error", err)
		return
	}
	p.Conn.SetPongHandler(func(string) error {
		return p.Conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, message, err := p.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Warn("unexpected WebSocket close", "peer", p.ID, "error", err)
			}
			return
		}

		p.Hub.ProcessMessage(p, message)
	}
}

// WritePump pumps messages from the hub to the WebSocket connection.
// Runs in its own goroutine per peer.
func (p *Peer) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		p.Close()
	}()

	for {
		select {
		case message, ok := <-p.Send:
			if err := p.Conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				slog.Error("failed to set write deadline", "peer", p.ID, "error", err)
				return
			}
			if !ok {
				// Hub closed the channel.
				_ = p.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := p.Conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			if _, err := w.Write(message); err != nil {
				return
			}
			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			if err := p.Conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				return
			}
			if err := p.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// SendMessage sends a JSON envelope to the peer.
func (p *Peer) SendMessage(msgType string, data any) {
	msg, err := MarshalEnvelope(msgType, data)
	if err != nil {
		slog.Error("failed to marshal message", "peer", p.ID, "type", msgType, "error", err)
		return
	}
	select {
	case p.Send <- msg:
	default:
		slog.Warn("peer send buffer full, dropping message", "peer", p.ID, "type", msgType)
	}
}

// SendError sends an error message to the peer.
func (p *Peer) SendError(code, message string) {
	p.SendMessage(MsgTypeError, ErrorMessage{
		Code:    code,
		Message: message,
	})
}

// Close closes the peer's WebSocket connection.
func (p *Peer) Close() {
	p.closeOnce.Do(func() {
		close(p.Send)
		_ = p.Conn.Close()
	})
}

// generatePeerID returns a cryptographically random 12-character hex ID.
func generatePeerID() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
