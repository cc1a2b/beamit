package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hassan/beamit/internal/signaling"
)

// testServer creates a Server with a running hub for testing.
func testServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	hub := signaling.NewHub()
	go hub.Run()

	s := &Server{
		config: cfg,
		hub:    hub,
	}
	return s
}

func TestHandleTURN_NoConfig(t *testing.T) {
	s := testServer(t, Config{})

	req := httptest.NewRequest(http.MethodGet, "/api/turn", nil)
	req.RemoteAddr = "1.2.3.4:12345"
	rec := httptest.NewRecorder()

	s.handleTURN(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	iceServers, ok := resp["ice_servers"].([]any)
	if !ok {
		t.Fatal("expected ice_servers to be an array")
	}
	if len(iceServers) != 0 {
		t.Errorf("expected empty ice_servers when TURN not configured, got %d", len(iceServers))
	}
}

func TestHandleTURN_WithConfig(t *testing.T) {
	s := testServer(t, Config{
		TURNSecret:   "test-secret",
		TURNPublicIP: "203.0.113.1",
		TURNPort:     3478,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/turn", nil)
	req.RemoteAddr = "1.2.3.4:12345"
	rec := httptest.NewRecorder()

	s.handleTURN(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	iceServers, ok := resp["ice_servers"].([]any)
	if !ok {
		t.Fatal("expected ice_servers to be an array")
	}
	if len(iceServers) != 1 {
		t.Fatalf("expected 1 ice server, got %d", len(iceServers))
	}

	server := iceServers[0].(map[string]any)
	if server["username"] == nil || server["username"] == "" {
		t.Error("expected non-empty username")
	}
	if server["credential"] == nil || server["credential"] == "" {
		t.Error("expected non-empty credential")
	}
	urls, ok := server["urls"].([]any)
	if !ok || len(urls) != 2 {
		t.Errorf("expected 2 TURN URIs, got %v", server["urls"])
	}

	ttl, ok := resp["ttl"].(float64)
	if !ok || ttl <= 0 {
		t.Errorf("expected positive TTL, got %v", resp["ttl"])
	}
}

func TestHandleHealth_IncludesRelayAndTURN(t *testing.T) {
	s := testServer(t, Config{TURNSecret: "test"})

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	s.handleHealth(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var resp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	// Check relay stats are present.
	if _, ok := resp["relay_chunks"]; !ok {
		t.Error("expected relay_chunks in health response")
	}
	if _, ok := resp["relay_bytes"]; !ok {
		t.Error("expected relay_bytes in health response")
	}

	// Check TURN enabled status.
	turnEnabled, ok := resp["turn_enabled"].(bool)
	if !ok {
		t.Error("expected turn_enabled to be a boolean")
	}
	if !turnEnabled {
		t.Error("expected turn_enabled=true when secret is set")
	}
}
