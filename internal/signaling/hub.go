package signaling

import (
	"encoding/json"
	"log/slog"
	"sync"
)

// Hub maintains the set of active peers and routes messages between them.
type Hub struct {
	// Registered peers mapped by ID.
	peers map[string]*Peer
	mu    sync.RWMutex

	// Register channel for new peers.
	Register chan *Peer

	// Unregister channel for departing peers.
	Unregister chan *Peer

	// Room manager.
	Rooms *RoomManager

	// LAN discovery.
	Discovery *Discovery
}

// NewHub creates a new Hub instance.
func NewHub() *Hub {
	return &Hub{
		peers:      make(map[string]*Peer),
		Register:   make(chan *Peer, 64),
		Unregister: make(chan *Peer, 64),
		Rooms:      NewRoomManager(),
		Discovery:  NewDiscovery(),
	}
}

// Run starts the hub's main event loop.
func (h *Hub) Run() {
	for {
		select {
		case peer := <-h.Register:
			h.registerPeer(peer)
		case peer := <-h.Unregister:
			h.unregisterPeer(peer)
		}
	}
}

// registerPeer adds a new peer to the hub.
func (h *Hub) registerPeer(peer *Peer) {
	h.mu.Lock()
	h.peers[peer.ID] = peer
	h.mu.Unlock()

	slog.Info("peer registered", "id", peer.ID, "ip", peer.PublicIP, "total_peers", h.PeerCount())
}

// unregisterPeer removes a peer from the hub.
func (h *Hub) unregisterPeer(peer *Peer) {
	h.mu.Lock()
	_, exists := h.peers[peer.ID]
	if exists {
		delete(h.peers, peer.ID)
	}
	h.mu.Unlock()

	if !exists {
		return
	}

	// Clean up room membership.
	h.Rooms.PeerDisconnected(peer)

	// Clean up discovery and notify LAN peers.
	h.Discovery.NotifyLANPeers(peer, MsgTypePeerLeft)
	h.Discovery.RemovePeer(peer)

	slog.Info("peer unregistered", "id", peer.ID, "total_peers", h.PeerCount())
}

// GetPeer returns a peer by ID.
func (h *Hub) GetPeer(id string) *Peer {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.peers[id]
}

// PeerCount returns the number of connected peers.
func (h *Hub) PeerCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.peers)
}

// ProcessMessage handles an incoming message from a peer.
func (h *Hub) ProcessMessage(sender *Peer, raw []byte) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		slog.Warn("invalid message format", "peer", sender.ID, "error", err)
		sender.SendError("invalid_message", "Invalid message format")
		return
	}

	switch env.Type {
	case MsgTypeJoin:
		h.handleJoin(sender, env.Data)
	case MsgTypeCreateRoom:
		h.handleCreateRoom(sender)
	case MsgTypeJoinRoom:
		h.handleJoinRoom(sender, env.Data)
	case MsgTypeLeaveRoom:
		h.handleLeaveRoom(sender)
	case MsgTypeOffer:
		h.handleSignaling(sender, MsgTypeOffer, env.Data)
	case MsgTypeAnswer:
		h.handleSignaling(sender, MsgTypeAnswer, env.Data)
	case MsgTypeICE:
		h.handleSignaling(sender, MsgTypeICE, env.Data)
	case MsgTypeTransferReq:
		h.handleTransferRequest(sender, env.Data)
	case MsgTypeTransferAck:
		h.handleTransferResponse(sender, MsgTypeTransferAck, env.Data)
	case MsgTypeTransferNack:
		h.handleTransferResponse(sender, MsgTypeTransferNack, env.Data)
	case MsgTypeRelayChunk:
		h.handleRelayChunk(sender, env.Data)
	case MsgTypeText:
		h.handleText(sender, env.Data)
	case MsgTypePing:
		sender.SendMessage(MsgTypePong, nil)
	default:
		slog.Warn("unknown message type", "peer", sender.ID, "type", env.Type)
		sender.SendError("unknown_type", "Unknown message type: "+env.Type)
	}
}

// handleJoin processes a join message — sets peer name/device info and triggers discovery.
func (h *Hub) handleJoin(peer *Peer, data json.RawMessage) {
	var msg JoinMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		peer.SendError("invalid_data", "Invalid join data")
		return
	}

	if msg.Name == "" {
		msg.Name = "Anonymous"
	}
	if msg.DeviceType == "" {
		msg.DeviceType = "desktop"
	}

	peer.Name = sanitizeString(msg.Name, 50)
	peer.DeviceType = sanitizeDeviceType(msg.DeviceType)

	// Add to discovery group and get LAN peers.
	h.Discovery.AddPeer(peer)

	// Send existing LAN peers to the new peer.
	lanPeers := h.Discovery.GetLANPeerInfos(peer)
	peer.SendMessage(MsgTypePeers, PeersMessage{Peers: lanPeers})

	// Notify existing LAN peers about the new peer.
	h.Discovery.NotifyLANPeers(peer, MsgTypePeerJoined)

	slog.Info("peer joined", "id", peer.ID, "name", peer.Name, "device", peer.DeviceType)
}

// handleCreateRoom creates a new room for the peer.
func (h *Hub) handleCreateRoom(peer *Peer) {
	code, err := h.Rooms.CreateRoom(peer)
	if err != nil {
		slog.Warn("failed to create room", "peer", peer.ID, "error", err)
		peer.SendError("room_create_failed", err.Error())
		return
	}

	peer.SendMessage(MsgTypeRoomCreated, RoomCreatedMessage{
		Code:      "BEAM-" + code,
		ExpiresIn: int(defaultRoomExpiry.Seconds()),
	})
}

// handleJoinRoom processes a room join request.
func (h *Hub) handleJoinRoom(peer *Peer, data json.RawMessage) {
	var msg JoinRoomMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		peer.SendError("invalid_data", "Invalid join_room data")
		return
	}

	room, err := h.Rooms.JoinRoom(msg.Code, peer)
	if err != nil {
		slog.Warn("failed to join room", "peer", peer.ID, "code", msg.Code, "error", err)
		peer.SendError("room_join_failed", err.Error())
		return
	}

	// Notify both peers about the successful pairing.
	room.mu.RLock()
	creator := room.Creator
	room.mu.RUnlock()

	peer.SendMessage(MsgTypeRoomJoined, RoomJoinedMessage{Peer: creator.Info()})
	creator.SendMessage(MsgTypeRoomJoined, RoomJoinedMessage{Peer: peer.Info()})
}

// handleLeaveRoom processes a room leave request.
func (h *Hub) handleLeaveRoom(peer *Peer) {
	h.Rooms.LeaveRoom(peer)
}

// handleSignaling forwards WebRTC signaling messages (SDP offers/answers, ICE candidates).
func (h *Hub) handleSignaling(sender *Peer, msgType string, data json.RawMessage) {
	var msg SignalingMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		sender.SendError("invalid_data", "Invalid signaling data")
		return
	}

	target := h.findTarget(sender, msg.Target)
	if target == nil {
		sender.SendError("peer_not_found", "Target peer not found or not accessible")
		return
	}

	// Forward the message with the sender's ID.
	outMsg := struct {
		Target    string          `json:"target"`
		SDP       string          `json:"sdp,omitempty"`
		Candidate json.RawMessage `json:"candidate,omitempty"`
	}{
		Target:    sender.ID,
		SDP:       msg.SDP,
		Candidate: msg.Candidate,
	}

	target.SendMessage(msgType, outMsg)
}

// handleTransferRequest forwards a file transfer request to the target peer.
func (h *Hub) handleTransferRequest(sender *Peer, data json.RawMessage) {
	var msg TransferRequestMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		sender.SendError("invalid_data", "Invalid transfer request data")
		return
	}

	target := h.findTarget(sender, msg.Target)
	if target == nil {
		sender.SendError("peer_not_found", "Target peer not found or not accessible")
		return
	}

	// Forward request with sender's ID.
	outMsg := TransferRequestMessage{
		Target: sender.ID,
		Files:  msg.Files,
	}
	target.SendMessage(MsgTypeTransferReq, outMsg)
}

// handleTransferResponse forwards a transfer accept/reject to the target peer.
func (h *Hub) handleTransferResponse(sender *Peer, msgType string, data json.RawMessage) {
	var msg TransferResponseMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		sender.SendError("invalid_data", "Invalid transfer response data")
		return
	}

	target := h.findTarget(sender, msg.Target)
	if target == nil {
		sender.SendError("peer_not_found", "Target peer not found or not accessible")
		return
	}

	outMsg := TransferResponseMessage{Target: sender.ID}
	target.SendMessage(msgType, outMsg)
}

// handleRelayChunk forwards a relay chunk to the target peer (WebSocket relay fallback).
func (h *Hub) handleRelayChunk(sender *Peer, data json.RawMessage) {
	var msg RelayChunkMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		sender.SendError("invalid_data", "Invalid relay chunk data")
		return
	}

	target := h.findTarget(sender, msg.Target)
	if target == nil {
		sender.SendError("peer_not_found", "Target peer not found")
		return
	}

	// Forward chunk with sender's ID.
	outMsg := RelayChunkMessage{
		Target: sender.ID,
		Data:   msg.Data,
		Seq:    msg.Seq,
		Final:  msg.Final,
	}
	target.SendMessage(MsgTypeRelayChunk, outMsg)
}

// handleText forwards a text message to the target peer.
func (h *Hub) handleText(sender *Peer, data json.RawMessage) {
	var msg TextMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		sender.SendError("invalid_data", "Invalid text data")
		return
	}

	target := h.findTarget(sender, msg.Target)
	if target == nil {
		sender.SendError("peer_not_found", "Target peer not found")
		return
	}

	outMsg := TextMessage{
		Target: sender.ID,
		Text:   msg.Text,
	}
	target.SendMessage(MsgTypeText, outMsg)
}

// findTarget locates a target peer, checking both LAN and room access.
func (h *Hub) findTarget(sender *Peer, targetID string) *Peer {
	target := h.GetPeer(targetID)
	if target == nil {
		return nil
	}

	// Allow if on same LAN (same public IP).
	if sender.PublicIP != "" && sender.PublicIP == target.PublicIP {
		return target
	}

	// Allow if in the same room.
	if sender.RoomCode != "" && sender.RoomCode == target.RoomCode {
		return target
	}

	slog.Warn("peer tried to reach inaccessible target",
		"sender", sender.ID, "target", targetID,
		"sender_ip", sender.PublicIP, "target_ip", target.PublicIP,
		"sender_room", sender.RoomCode, "target_room", target.RoomCode,
	)
	return nil
}

// sanitizeString truncates a string to maxLen and strips control characters.
func sanitizeString(s string, maxLen int) string {
	if len(s) > maxLen {
		s = s[:maxLen]
	}
	// Strip control characters.
	clean := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] >= 32 && s[i] != 127 {
			clean = append(clean, s[i])
		}
	}
	return string(clean)
}

// sanitizeDeviceType validates the device type string.
func sanitizeDeviceType(dt string) string {
	switch dt {
	case "phone", "tablet", "laptop", "desktop":
		return dt
	default:
		return "desktop"
	}
}
