package signaling

import (
	"strings"
	"testing"
	"time"
)

func TestGenerateRoomCode(t *testing.T) {
	// Generate multiple codes and check properties.
	seen := make(map[string]bool)

	for i := 0; i < 100; i++ {
		code, err := generateRoomCode()
		if err != nil {
			t.Fatalf("generateRoomCode() error: %v", err)
		}

		if len(code) != roomCodeLength {
			t.Errorf("expected code length %d, got %d: %s", roomCodeLength, len(code), code)
		}

		// Check that code only contains allowed characters.
		for _, c := range code {
			if !strings.ContainsRune(roomCodeChars, c) {
				t.Errorf("code contains invalid character %c: %s", c, code)
			}
		}

		// Check no confusing characters.
		for _, c := range "0OoIiLl1" {
			if strings.ContainsRune(code, c) {
				t.Errorf("code contains confusing character %c: %s", c, code)
			}
		}

		seen[code] = true
	}

	// With 100 codes of 4 chars from 30-char alphabet, collisions are very unlikely.
	if len(seen) < 90 {
		t.Errorf("too many collisions: only %d unique codes out of 100", len(seen))
	}
}

func TestRoomManager_CreateRoom(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	peer := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")

	code, err := rm.CreateRoom(peer)
	if err != nil {
		t.Fatalf("CreateRoom() error: %v", err)
	}

	if len(code) != roomCodeLength {
		t.Errorf("expected code length %d, got %d", roomCodeLength, len(code))
	}

	if peer.RoomCode != code {
		t.Errorf("expected peer room code %s, got %s", code, peer.RoomCode)
	}

	if rm.RoomCount() != 1 {
		t.Errorf("expected 1 room, got %d", rm.RoomCount())
	}
}

func TestRoomManager_CreateRoom_MaxRooms(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	peer := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")

	// Create max rooms.
	for i := 0; i < maxRoomsPerPeer; i++ {
		_, err := rm.CreateRoom(peer)
		if err != nil {
			t.Fatalf("CreateRoom() #%d error: %v", i, err)
		}
	}

	// Next one should fail.
	_, err := rm.CreateRoom(peer)
	if err == nil {
		t.Error("expected error when exceeding max rooms per peer")
	}
}

func TestRoomManager_JoinRoom(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	creator := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")
	joiner := fakePeer(t, hub, "p2", "Joiner", "5.6.7.8")

	code, err := rm.CreateRoom(creator)
	if err != nil {
		t.Fatalf("CreateRoom() error: %v", err)
	}

	room, err := rm.JoinRoom(code, joiner)
	if err != nil {
		t.Fatalf("JoinRoom() error: %v", err)
	}

	if room.Creator.ID != "p1" {
		t.Errorf("expected creator p1, got %s", room.Creator.ID)
	}
	if room.Joiner.ID != "p2" {
		t.Errorf("expected joiner p2, got %s", room.Joiner.ID)
	}
	if joiner.RoomCode != code {
		t.Errorf("expected joiner room code %s, got %s", code, joiner.RoomCode)
	}
}

func TestRoomManager_JoinRoom_WithPrefix(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	creator := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")
	joiner := fakePeer(t, hub, "p2", "Joiner", "5.6.7.8")

	code, _ := rm.CreateRoom(creator)

	// Join with BEAM- prefix.
	_, err := rm.JoinRoom("BEAM-"+code, joiner)
	if err != nil {
		t.Fatalf("JoinRoom() with prefix error: %v", err)
	}
}

func TestRoomManager_JoinRoom_CaseInsensitive(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	creator := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")
	joiner := fakePeer(t, hub, "p2", "Joiner", "5.6.7.8")

	code, _ := rm.CreateRoom(creator)

	// Join with lowercase code.
	_, err := rm.JoinRoom(strings.ToLower(code), joiner)
	if err != nil {
		t.Fatalf("JoinRoom() with lowercase error: %v", err)
	}
}

func TestRoomManager_JoinRoom_NotFound(t *testing.T) {
	rm := NewRoomManager()
	hub := testHub(t)
	joiner := fakePeer(t, hub, "p2", "Joiner", "5.6.7.8")

	_, err := rm.JoinRoom("XXXX", joiner)
	if err == nil {
		t.Error("expected error for non-existent room")
	}
}

func TestRoomManager_JoinRoom_Full(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	creator := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")
	joiner1 := fakePeer(t, hub, "p2", "Joiner1", "5.6.7.8")
	joiner2 := fakePeer(t, hub, "p3", "Joiner2", "9.10.11.12")

	code, _ := rm.CreateRoom(creator)
	rm.JoinRoom(code, joiner1)

	_, err := rm.JoinRoom(code, joiner2)
	if err == nil {
		t.Error("expected error when room is full")
	}
}

func TestRoomManager_JoinRoom_Self(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	creator := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")

	code, _ := rm.CreateRoom(creator)

	_, err := rm.JoinRoom(code, creator)
	if err == nil {
		t.Error("expected error when joining own room")
	}
}

func TestRoomManager_LeaveRoom_Creator(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	creator := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")
	joiner := fakePeer(t, hub, "p2", "Joiner", "5.6.7.8")

	code, _ := rm.CreateRoom(creator)
	rm.JoinRoom(code, joiner)

	// Creator leaves — room should be destroyed.
	rm.LeaveRoom(creator)

	if rm.RoomCount() != 0 {
		t.Errorf("expected 0 rooms after creator left, got %d", rm.RoomCount())
	}
	if creator.RoomCode != "" {
		t.Errorf("expected empty room code for creator, got %s", creator.RoomCode)
	}
	if joiner.RoomCode != "" {
		t.Errorf("expected empty room code for joiner, got %s", joiner.RoomCode)
	}
}

func TestRoomManager_LeaveRoom_Joiner(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	creator := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")
	joiner := fakePeer(t, hub, "p2", "Joiner", "5.6.7.8")

	code, _ := rm.CreateRoom(creator)
	rm.JoinRoom(code, joiner)

	// Joiner leaves — room should still exist.
	rm.LeaveRoom(joiner)

	if rm.RoomCount() != 1 {
		t.Errorf("expected 1 room after joiner left, got %d", rm.RoomCount())
	}
	if joiner.RoomCode != "" {
		t.Errorf("expected empty room code for joiner, got %s", joiner.RoomCode)
	}
	if creator.RoomCode != code {
		t.Errorf("expected creator still in room %s, got %s", code, creator.RoomCode)
	}
}

func TestRoomManager_PeerDisconnected(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	creator := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")

	code, _ := rm.CreateRoom(creator)
	if code == "" {
		t.Fatal("expected non-empty room code")
	}

	rm.PeerDisconnected(creator)

	if rm.RoomCount() != 0 {
		t.Errorf("expected 0 rooms after disconnect, got %d", rm.RoomCount())
	}
}

func TestRoomManager_GetRoomPeer(t *testing.T) {
	hub := testHub(t)
	rm := NewRoomManager()

	creator := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")
	joiner := fakePeer(t, hub, "p2", "Joiner", "5.6.7.8")

	code, _ := rm.CreateRoom(creator)
	rm.JoinRoom(code, joiner)

	// From creator's perspective, should get joiner.
	other := rm.GetRoomPeer(code, "p1")
	if other == nil || other.ID != "p2" {
		t.Error("expected to get joiner from creator's perspective")
	}

	// From joiner's perspective, should get creator.
	other = rm.GetRoomPeer(code, "p2")
	if other == nil || other.ID != "p1" {
		t.Error("expected to get creator from joiner's perspective")
	}
}

func TestRoomManager_CleanupExpired(t *testing.T) {
	hub := testHub(t)
	rm := &RoomManager{
		rooms: make(map[string]*Room),
	}

	creator := fakePeer(t, hub, "p1", "Creator", "1.2.3.4")

	// Create a room that's already expired.
	rm.rooms["TEST"] = &Room{
		Code:      "TEST",
		Creator:   creator,
		CreatedAt: time.Now().Add(-20 * time.Minute),
		ExpiresAt: time.Now().Add(-10 * time.Minute),
	}
	creator.RoomCode = "TEST"

	rm.cleanupExpired()

	if rm.RoomCount() != 0 {
		t.Errorf("expected 0 rooms after cleanup, got %d", rm.RoomCount())
	}
	if creator.RoomCode != "" {
		t.Errorf("expected empty room code after cleanup, got %s", creator.RoomCode)
	}
}
