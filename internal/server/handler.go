package server

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/hassan/beamit/internal/relay"
	"github.com/hassan/beamit/internal/signaling"
	"github.com/hassan/beamit/internal/turn"
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

	relayChunks, relayBytes := relay.GetStats()
	stats := map[string]any{
		"status":         "ok",
		"peers":          s.hub.PeerCount(),
		"rooms":          s.hub.Rooms.RoomCount(),
		"lan_groups":     s.hub.Discovery.GroupCount(),
		"relay_chunks":   relayChunks,
		"relay_bytes":    relayBytes,
		"turn_enabled":   s.config.TURNSecret != "",
	}

	if err := json.NewEncoder(w).Encode(stats); err != nil {
		slog.Error("failed to encode health response", "error", err)
	}
}

// handleTURN returns TURN server credentials for WebRTC ICE configuration.
func (s *Server) handleTURN(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Return empty ice_servers if TURN not configured (graceful degradation).
	if s.config.TURNSecret == "" || s.config.TURNPublicIP == "" {
		resp := map[string]any{
			"ice_servers": []any{},
			"ttl":         0,
		}
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.Error("failed to encode TURN response", "error", err)
		}
		return
	}

	// Generate unique client ID from request IP.
	clientID := extractIP(r)
	cfg := turn.Config{
		Port:     s.config.TURNPort,
		PublicIP: s.config.TURNPublicIP,
		Secret:   s.config.TURNSecret,
	}

	creds, err := turn.GenerateCredentials(cfg, clientID)
	if err != nil {
		slog.Error("failed to generate TURN credentials", "error", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	// Return in WebRTC-compatible ICE server format.
	iceServer := map[string]any{
		"urls":       creds.URIs,
		"username":   creds.Username,
		"credential": creds.Password,
	}

	resp := map[string]any{
		"ice_servers": []any{iceServer},
		"ttl":         creds.TTL,
	}

	if err := json.NewEncoder(w).Encode(resp); err != nil {
		slog.Error("failed to encode TURN response", "error", err)
	}
}
