package server

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/hassan/beamit/internal/signaling"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		// Allow all origins — BeamIt is designed to be accessed from any device.
		// CORS and CSP headers provide protection at the browser level.
		return true
	},
}

// handleWebSocket upgrades HTTP to WebSocket and registers the peer.
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("WebSocket upgrade failed", "error", err, "ip", extractIP(r))
		return
	}

	publicIP := extractIP(r)
	peer, err := signaling.NewPeer(conn, s.hub, publicIP)
	if err != nil {
		slog.Error("failed to create peer", "error", err)
		_ = conn.Close()
		return
	}

	s.hub.Register <- peer

	// Start read/write pumps in separate goroutines.
	go peer.WritePump()
	go peer.ReadPump()
}

// handleHealth returns server health and stats.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	stats := map[string]any{
		"status":     "ok",
		"peers":      s.hub.PeerCount(),
		"rooms":      s.hub.Rooms.RoomCount(),
		"lan_groups": s.hub.Discovery.GroupCount(),
	}

	if err := json.NewEncoder(w).Encode(stats); err != nil {
		slog.Error("failed to encode health response", "error", err)
	}
}
