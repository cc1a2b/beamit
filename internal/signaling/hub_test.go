package signaling

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// testHub creates a Hub and starts its event loop in a goroutine.
func testHub(t *testing.T) *Hub {
	t.Helper()
	hub := NewHub()
	go hub.Run()
	return hub
}

// fakePeer creates a Peer with a mock connection for testing.
func fakePeer(t *testing.T, hub *Hub, id, name, publicIP string) *Peer {
	t.Helper()
	// Create a server/client pair of WebSocket connections
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade failed: %v", err)
		}
		_ = conn
	}))
	t.Cleanup(server.Close)

	url := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	p := &Peer{
		ID:         id,
		Name:       name,
		DeviceType: "desktop",
		PublicIP:   publicIP,
		Conn:       conn,
		Send:       make(chan []byte, sendBufferSize),
		Hub:        hub,
		JoinedAt:   time.Now(),
	}

	return p
}

func TestHubRegisterUnregister(t *testing.T) {
	hub := testHub(t)

	peer := fakePeer(t, hub, "test1", "Test Peer", "1.2.3.4")

	hub.Register <- peer
	time.Sleep(50 * time.Millisecond)

	if hub.PeerCount() != 1 {
		t.Errorf("expected 1 peer, got %d", hub.PeerCount())
	}

	if got := hub.GetPeer("test1"); got == nil {
		t.Error("expected to find peer test1")
	}

	hub.Unregister <- peer
	time.Sleep(50 * time.Millisecond)

	if hub.PeerCount() != 0 {
		t.Errorf("expected 0 peers, got %d", hub.PeerCount())
	}
}

func TestHubMessageProcessing_Join(t *testing.T) {
	hub := testHub(t)

	peer := fakePeer(t, hub, "p1", "", "1.2.3.4")
	hub.Register <- peer
	time.Sleep(50 * time.Millisecond)

	// Process a join message.
	joinData, _ := json.Marshal(JoinMessage{Name: "Alice", DeviceType: "phone"})
	msg, _ := json.Marshal(Envelope{Type: MsgTypeJoin, Data: joinData})
	hub.ProcessMessage(peer, msg)

	if peer.Name != "Alice" {
		t.Errorf("expected name 'Alice', got '%s'", peer.Name)
	}
	if peer.DeviceType != "phone" {
		t.Errorf("expected device type 'phone', got '%s'", peer.DeviceType)
	}
}

func TestHubMessageProcessing_UnknownType(t *testing.T) {
	hub := testHub(t)

	peer := fakePeer(t, hub, "p1", "Test", "1.2.3.4")
	hub.Register <- peer
	time.Sleep(50 * time.Millisecond)

	// Process an unknown message type — should send an error.
	msg, _ := json.Marshal(Envelope{Type: "nonsense"})
	hub.ProcessMessage(peer, msg)

	// Check that an error was queued.
	select {
	case raw := <-peer.Send:
		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}
		if env.Type != MsgTypeError {
			t.Errorf("expected error message, got %s", env.Type)
		}
	case <-time.After(time.Second):
		t.Error("expected error message, got nothing")
	}
}

func TestSanitizeString(t *testing.T) {
	tests := []struct {
		input    string
		maxLen   int
		expected string
	}{
		{"hello", 10, "hello"},
		{"hello world", 5, "hello"},
		{"hello\x00world", 20, "helloworld"},
		{"test\x1b[31m", 20, "test[31m"},
	}

	for _, tt := range tests {
		result := sanitizeString(tt.input, tt.maxLen)
		if result != tt.expected {
			t.Errorf("sanitizeString(%q, %d) = %q, want %q", tt.input, tt.maxLen, result, tt.expected)
		}
	}
}

func TestSanitizeDeviceType(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"phone", "phone"},
		{"tablet", "tablet"},
		{"laptop", "laptop"},
		{"desktop", "desktop"},
		{"smartwatch", "desktop"},
		{"", "desktop"},
	}

	for _, tt := range tests {
		result := sanitizeDeviceType(tt.input)
		if result != tt.expected {
			t.Errorf("sanitizeDeviceType(%q) = %q, want %q", tt.input, result, tt.expected)
		}
	}
}

func TestFindTarget_SameLAN(t *testing.T) {
	hub := testHub(t)

	peer1 := fakePeer(t, hub, "a1", "Peer A", "1.2.3.4")
	peer2 := fakePeer(t, hub, "b2", "Peer B", "1.2.3.4")

	hub.Register <- peer1
	hub.Register <- peer2
	time.Sleep(50 * time.Millisecond)

	// Same LAN peers should be able to reach each other.
	target := hub.findTarget(peer1, "b2")
	if target == nil {
		t.Error("expected to find peer b2 from same LAN")
	}
}

func TestFindTarget_DifferentLAN_NoRoom(t *testing.T) {
	hub := testHub(t)

	peer1 := fakePeer(t, hub, "a1", "Peer A", "1.2.3.4")
	peer2 := fakePeer(t, hub, "b2", "Peer B", "5.6.7.8")

	hub.Register <- peer1
	hub.Register <- peer2
	time.Sleep(50 * time.Millisecond)

	// Different LAN without a room should NOT be reachable.
	target := hub.findTarget(peer1, "b2")
	if target != nil {
		t.Error("expected nil target for different LAN without room")
	}
}

func TestFindTarget_SameRoom(t *testing.T) {
	hub := testHub(t)

	peer1 := fakePeer(t, hub, "a1", "Peer A", "1.2.3.4")
	peer2 := fakePeer(t, hub, "b2", "Peer B", "5.6.7.8")

	hub.Register <- peer1
	hub.Register <- peer2
	time.Sleep(50 * time.Millisecond)

	// Put them in the same room.
	peer1.RoomCode = "TEST"
	peer2.RoomCode = "TEST"

	target := hub.findTarget(peer1, "b2")
	if target == nil {
		t.Error("expected to find peer b2 in same room")
	}
}

func TestHubKeyExchangeForwarding(t *testing.T) {
	hub := testHub(t)

	peer1 := fakePeer(t, hub, "kx1", "Peer 1", "1.2.3.4")
	peer2 := fakePeer(t, hub, "kx2", "Peer 2", "1.2.3.4")

	hub.Register <- peer1
	hub.Register <- peer2
	time.Sleep(50 * time.Millisecond)

	// Send a key_exchange message from peer1 to peer2.
	sigData, _ := json.Marshal(SignalingMessage{
		Target: "kx2",
		SDP:    "fake-public-key-base64",
	})
	msg, _ := json.Marshal(Envelope{Type: MsgTypeKeyExchange, Data: sigData})
	hub.ProcessMessage(peer1, msg)

	// peer2 should receive the forwarded key_exchange.
	select {
	case raw := <-peer2.Send:
		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}
		if env.Type != MsgTypeKeyExchange {
			t.Errorf("expected key_exchange message, got %s", env.Type)
		}
	case <-time.After(time.Second):
		t.Error("expected key_exchange message, got nothing")
	}
}

func TestHubRelayChunkRecordsStats(t *testing.T) {
	hub := testHub(t)

	peer1 := fakePeer(t, hub, "r1", "Peer 1", "1.2.3.4")
	peer2 := fakePeer(t, hub, "r2", "Peer 2", "1.2.3.4")

	hub.Register <- peer1
	hub.Register <- peer2
	time.Sleep(50 * time.Millisecond)

	// Send a relay_chunk from peer1 to peer2.
	chunkData, _ := json.Marshal(RelayChunkMessage{
		Target: "r2",
		Data:   "dGVzdGRhdGE=", // "testdata" base64
		Seq:    0,
	})
	msg, _ := json.Marshal(Envelope{Type: MsgTypeRelayChunk, Data: chunkData})
	hub.ProcessMessage(peer1, msg)

	// peer2 should receive the chunk.
	select {
	case raw := <-peer2.Send:
		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}
		if env.Type != MsgTypeRelayChunk {
			t.Errorf("expected relay_chunk message, got %s", env.Type)
		}
	case <-time.After(time.Second):
		t.Error("expected relay_chunk message, got nothing")
	}
}

func TestConcurrentPeerAccess(t *testing.T) {
	hub := testHub(t)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := "peer" + string(rune('A'+i%26)) + string(rune('0'+i/26))
			peer := fakePeer(t, hub, id, "Peer", "1.2.3.4")
			hub.Register <- peer
			time.Sleep(10 * time.Millisecond)
			hub.Unregister <- peer
		}(i)
	}
	wg.Wait()
	time.Sleep(100 * time.Millisecond)

	if count := hub.PeerCount(); count != 0 {
		t.Errorf("expected 0 peers after cleanup, got %d", count)
	}
}
