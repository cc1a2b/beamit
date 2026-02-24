package signaling

import (
	"encoding/json"
	"testing"
)

func TestMarshalEnvelope(t *testing.T) {
	msg, err := MarshalEnvelope(MsgTypePeers, PeersMessage{
		Peers: []PeerInfo{
			{ID: "a1", Name: "Phone", DeviceType: "phone"},
			{ID: "b2", Name: "Laptop", DeviceType: "laptop"},
		},
	})
	if err != nil {
		t.Fatalf("MarshalEnvelope error: %v", err)
	}

	var env Envelope
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if env.Type != MsgTypePeers {
		t.Errorf("expected type %s, got %s", MsgTypePeers, env.Type)
	}

	var peers PeersMessage
	if err := json.Unmarshal(env.Data, &peers); err != nil {
		t.Fatalf("unmarshal peers error: %v", err)
	}

	if len(peers.Peers) != 2 {
		t.Errorf("expected 2 peers, got %d", len(peers.Peers))
	}
	if peers.Peers[0].Name != "Phone" {
		t.Errorf("expected name 'Phone', got '%s'", peers.Peers[0].Name)
	}
}

func TestMarshalEnvelope_Error(t *testing.T) {
	msg, err := MarshalEnvelope(MsgTypeError, ErrorMessage{
		Code:    "test_error",
		Message: "something went wrong",
	})
	if err != nil {
		t.Fatalf("MarshalEnvelope error: %v", err)
	}

	var env Envelope
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if env.Type != MsgTypeError {
		t.Errorf("expected type %s, got %s", MsgTypeError, env.Type)
	}

	var errMsg ErrorMessage
	if err := json.Unmarshal(env.Data, &errMsg); err != nil {
		t.Fatalf("unmarshal error message: %v", err)
	}

	if errMsg.Code != "test_error" {
		t.Errorf("expected code 'test_error', got '%s'", errMsg.Code)
	}
}

func TestMarshalEnvelope_NilData(t *testing.T) {
	msg, err := MarshalEnvelope(MsgTypePong, nil)
	if err != nil {
		t.Fatalf("MarshalEnvelope error: %v", err)
	}

	var env Envelope
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}

	if env.Type != MsgTypePong {
		t.Errorf("expected type %s, got %s", MsgTypePong, env.Type)
	}
}
