package signaling

import (
	"crypto/rand"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"sync"
	"time"
)

const (
	// Room code length (excluding "BEAM-" prefix).
	roomCodeLength = 4

	// Characters allowed in room codes (excluded confusing: 0/O, 1/I/L).
	roomCodeChars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

	// Default room expiration time.
	defaultRoomExpiry = 10 * time.Minute

	// Maximum rooms per peer.
	maxRoomsPerPeer = 3
)

// Room represents a pairing session between two peers.
type Room struct {
	Code      string
	Creator   *Peer
	Joiner    *Peer
	CreatedAt time.Time
	ExpiresAt time.Time
	mu        sync.RWMutex
}

// RoomManager manages room creation, joining, and expiration.
type RoomManager struct {
	rooms map[string]*Room
	mu    sync.RWMutex
}

// NewRoomManager creates a new RoomManager and starts the expiry cleanup goroutine.
func NewRoomManager() *RoomManager {
	rm := &RoomManager{
		rooms: make(map[string]*Room),
	}
	go rm.cleanupLoop()
	return rm
}

// CreateRoom creates a new room for a peer and returns the room code.
func (rm *RoomManager) CreateRoom(creator *Peer) (string, error) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	// Check if peer already has too many rooms.
	count := 0
	for _, room := range rm.rooms {
		if room.Creator.ID == creator.ID {
			count++
		}
	}
	if count >= maxRoomsPerPeer {
		return "", fmt.Errorf("maximum rooms per peer exceeded (%d)", maxRoomsPerPeer)
	}

	// Generate a unique room code with retries.
	var code string
	for attempts := 0; attempts < 10; attempts++ {
		candidate, err := generateRoomCode()
		if err != nil {
			return "", fmt.Errorf("generating room code: %w", err)
		}
		if _, exists := rm.rooms[candidate]; !exists {
			code = candidate
			break
		}
	}
	if code == "" {
		return "", fmt.Errorf("failed to generate unique room code after retries")
	}

	now := time.Now()
	room := &Room{
		Code:      code,
		Creator:   creator,
		CreatedAt: now,
		ExpiresAt: now.Add(defaultRoomExpiry),
	}

	rm.rooms[code] = room
	creator.RoomCode = code

	slog.Info("room created", "code", code, "creator", creator.ID)
	return code, nil
}

// JoinRoom adds a peer to an existing room.
func (rm *RoomManager) JoinRoom(code string, joiner *Peer) (*Room, error) {
	code = strings.ToUpper(strings.TrimSpace(code))

	// Strip "BEAM-" prefix if present.
	code = strings.TrimPrefix(code, "BEAM-")

	rm.mu.Lock()
	defer rm.mu.Unlock()

	room, exists := rm.rooms[code]
	if !exists {
		return nil, fmt.Errorf("room not found: %s", code)
	}

	if time.Now().After(room.ExpiresAt) {
		delete(rm.rooms, code)
		return nil, fmt.Errorf("room expired: %s", code)
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if room.Joiner != nil {
		return nil, fmt.Errorf("room already full: %s", code)
	}

	if room.Creator.ID == joiner.ID {
		return nil, fmt.Errorf("cannot join your own room")
	}

	room.Joiner = joiner
	joiner.RoomCode = code

	slog.Info("peer joined room", "code", code, "joiner", joiner.ID)
	return room, nil
}

// LeaveRoom removes a peer from their current room.
func (rm *RoomManager) LeaveRoom(peer *Peer) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	if peer.RoomCode == "" {
		return
	}

	room, exists := rm.rooms[peer.RoomCode]
	if !exists {
		peer.RoomCode = ""
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	// If the creator leaves, destroy the room.
	if room.Creator != nil && room.Creator.ID == peer.ID {
		if room.Joiner != nil {
			room.Joiner.RoomCode = ""
			room.Joiner.SendMessage(MsgTypeRoomLeft, RoomLeftMessage{PeerID: peer.ID})
		}
		delete(rm.rooms, peer.RoomCode)
		slog.Info("room destroyed (creator left)", "code", peer.RoomCode)
	} else if room.Joiner != nil && room.Joiner.ID == peer.ID {
		// If the joiner leaves, notify the creator.
		room.Joiner = nil
		if room.Creator != nil {
			room.Creator.SendMessage(MsgTypeRoomLeft, RoomLeftMessage{PeerID: peer.ID})
		}
		slog.Info("peer left room", "code", peer.RoomCode, "peer", peer.ID)
	}

	peer.RoomCode = ""
}

// GetRoom returns a room by code.
func (rm *RoomManager) GetRoom(code string) *Room {
	rm.mu.RLock()
	defer rm.mu.RUnlock()

	code = strings.ToUpper(strings.TrimSpace(code))
	code = strings.TrimPrefix(code, "BEAM-")
	return rm.rooms[code]
}

// GetRoomPeer returns the other peer in a room given one peer's ID.
func (rm *RoomManager) GetRoomPeer(code, peerID string) *Peer {
	room := rm.GetRoom(code)
	if room == nil {
		return nil
	}

	room.mu.RLock()
	defer room.mu.RUnlock()

	if room.Creator != nil && room.Creator.ID == peerID {
		return room.Joiner
	}
	if room.Joiner != nil && room.Joiner.ID == peerID {
		return room.Creator
	}
	return nil
}

// PeerDisconnected handles a peer disconnecting — cleans up their rooms.
func (rm *RoomManager) PeerDisconnected(peer *Peer) {
	rm.LeaveRoom(peer)
}

// RoomCount returns the number of active rooms.
func (rm *RoomManager) RoomCount() int {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	return len(rm.rooms)
}

// cleanupLoop periodically removes expired rooms.
func (rm *RoomManager) cleanupLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		rm.cleanupExpired()
	}
}

// cleanupExpired removes all expired rooms.
func (rm *RoomManager) cleanupExpired() {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	now := time.Now()
	for code, room := range rm.rooms {
		if now.After(room.ExpiresAt) {
			room.mu.Lock()
			if room.Creator != nil {
				room.Creator.RoomCode = ""
				room.Creator.SendError("room_expired", "Room "+code+" has expired")
			}
			if room.Joiner != nil {
				room.Joiner.RoomCode = ""
				room.Joiner.SendError("room_expired", "Room "+code+" has expired")
			}
			room.mu.Unlock()
			delete(rm.rooms, code)
			slog.Info("room expired and cleaned up", "code", code)
		}
	}
}

// generateRoomCode creates a cryptographically random room code.
func generateRoomCode() (string, error) {
	code := make([]byte, roomCodeLength)
	max := big.NewInt(int64(len(roomCodeChars)))

	for i := range code {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		code[i] = roomCodeChars[n.Int64()]
	}

	return string(code), nil
}
