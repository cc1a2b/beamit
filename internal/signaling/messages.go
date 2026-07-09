package signaling

import "encoding/json"

// Message types for WebSocket protocol
const (
	// Client → Server
	MsgTypeJoin          = "join"
	MsgTypeCreateRoom    = "create_room"
	MsgTypeJoinRoom      = "join_room"
	MsgTypeLeaveRoom     = "leave_room"
	MsgTypeOffer         = "offer"
	MsgTypeAnswer        = "answer"
	MsgTypeICE           = "ice"
	MsgTypeTransferReq   = "transfer_request"
	MsgTypeTransferAck   = "transfer_accept"
	MsgTypeTransferNack  = "transfer_reject"
	MsgTypeRelayChunk    = "relay_chunk"
	MsgTypeKeyExchange   = "key_exchange"
	MsgTypeText          = "text"
	MsgTypePing          = "ping"

	// Server → Client
	MsgTypePeers        = "peers"
	MsgTypeRoomCreated  = "room_created"
	MsgTypeRoomJoined   = "room_joined"
	MsgTypeRoomLeft     = "room_left"
	MsgTypePeerJoined   = "peer_joined"
	MsgTypePeerLeft     = "peer_left"
	MsgTypeError        = "error"
	MsgTypePong         = "pong"
)

// Envelope is the base message wrapper for all WebSocket messages.
type Envelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// JoinMessage is sent by a peer when connecting.
type JoinMessage struct {
	Name       string `json:"name"`
	DeviceType string `json:"device_type"` // "phone", "tablet", "laptop", "desktop"
}

// PeerInfo represents a peer visible to other peers.
type PeerInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	DeviceType string `json:"device_type"`
}

// PeersMessage lists peers on the same network.
type PeersMessage struct {
	Peers []PeerInfo `json:"peers"`
}

// RoomCreatedMessage is sent after a room is created.
type RoomCreatedMessage struct {
	Code      string `json:"code"`
	ExpiresIn int    `json:"expires_in"` // seconds
}

// JoinRoomMessage is sent by a peer to join a room.
type JoinRoomMessage struct {
	Code string `json:"code"`
}

// RoomJoinedMessage is sent to both peers when the second peer joins.
type RoomJoinedMessage struct {
	Peer PeerInfo `json:"peer"`
}

// RoomLeftMessage is sent when a peer leaves a room.
type RoomLeftMessage struct {
	PeerID string `json:"peer_id"`
}

// SignalingMessage forwards SDP offers/answers or ICE candidates.
type SignalingMessage struct {
	Target    string          `json:"target"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}

// FileInfo describes a file being offered for transfer.
type FileInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Type string `json:"type,omitempty"`
}

// TransferRequestMessage is sent to initiate a file transfer.
type TransferRequestMessage struct {
	Target string     `json:"target"`
	Files  []FileInfo `json:"files"`
}

// TransferResponseMessage is sent to accept/reject a transfer.
type TransferResponseMessage struct {
	Target string `json:"target"`
}

// RelayChunkMessage is used for WebSocket relay fallback.
type RelayChunkMessage struct {
	Target string `json:"target"`
	Data   string `json:"data"` // base64 encoded encrypted chunk
	Seq    int64  `json:"seq"`
	Final  bool   `json:"final,omitempty"`
}

// TextMessage is sent to share text/clipboard content.
type TextMessage struct {
	Target string `json:"target"`
	Text   string `json:"text"`
}

// ErrorMessage is sent to indicate an error.
type ErrorMessage struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// MarshalEnvelope creates a JSON envelope for a message.
func MarshalEnvelope(msgType string, data any) ([]byte, error) {
	dataBytes, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Envelope{
		Type: msgType,
		Data: json.RawMessage(dataBytes),
	})
}
