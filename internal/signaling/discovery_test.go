package signaling

import (
	"testing"
)

func TestDiscovery_AddRemovePeer(t *testing.T) {
	hub := testHub(t)
	d := NewDiscovery()

	p1 := fakePeer(t, hub, "a1", "A", "1.2.3.4")
	p2 := fakePeer(t, hub, "b2", "B", "1.2.3.4")
	p3 := fakePeer(t, hub, "c3", "C", "5.6.7.8")

	d.AddPeer(p1)
	d.AddPeer(p2)
	d.AddPeer(p3)

	if d.GroupCount() != 2 {
		t.Errorf("expected 2 groups, got %d", d.GroupCount())
	}
	if d.PeerCount() != 3 {
		t.Errorf("expected 3 peers, got %d", d.PeerCount())
	}

	d.RemovePeer(p1)

	if d.PeerCount() != 2 {
		t.Errorf("expected 2 peers after removal, got %d", d.PeerCount())
	}

	d.RemovePeer(p2)

	// Group 1.2.3.4 should be cleaned up now.
	if d.GroupCount() != 1 {
		t.Errorf("expected 1 group after removing both peers, got %d", d.GroupCount())
	}
}

func TestDiscovery_GetLANPeers(t *testing.T) {
	hub := testHub(t)
	d := NewDiscovery()

	p1 := fakePeer(t, hub, "a1", "A", "1.2.3.4")
	p2 := fakePeer(t, hub, "b2", "B", "1.2.3.4")
	p3 := fakePeer(t, hub, "c3", "C", "5.6.7.8")

	d.AddPeer(p1)
	d.AddPeer(p2)
	d.AddPeer(p3)

	// p1 should see p2 as LAN peer.
	lanPeers := d.GetLANPeers(p1)
	if len(lanPeers) != 1 {
		t.Fatalf("expected 1 LAN peer for p1, got %d", len(lanPeers))
	}
	if lanPeers[0].ID != "b2" {
		t.Errorf("expected LAN peer b2, got %s", lanPeers[0].ID)
	}

	// p3 should see no LAN peers.
	lanPeers = d.GetLANPeers(p3)
	if len(lanPeers) != 0 {
		t.Errorf("expected 0 LAN peers for p3, got %d", len(lanPeers))
	}
}

func TestDiscovery_GetLANPeerInfos(t *testing.T) {
	hub := testHub(t)
	d := NewDiscovery()

	p1 := fakePeer(t, hub, "a1", "A", "10.0.0.1")
	p2 := fakePeer(t, hub, "b2", "B", "10.0.0.1")
	p1.Name = "Phone"
	p1.DeviceType = "phone"
	p2.Name = "Laptop"
	p2.DeviceType = "laptop"

	d.AddPeer(p1)
	d.AddPeer(p2)

	infos := d.GetLANPeerInfos(p1)
	if len(infos) != 1 {
		t.Fatalf("expected 1 LAN peer info, got %d", len(infos))
	}
	if infos[0].Name != "Laptop" {
		t.Errorf("expected name 'Laptop', got '%s'", infos[0].Name)
	}
	if infos[0].DeviceType != "laptop" {
		t.Errorf("expected device 'laptop', got '%s'", infos[0].DeviceType)
	}
}

func TestDiscovery_EmptyIP(t *testing.T) {
	hub := testHub(t)
	d := NewDiscovery()

	p := fakePeer(t, hub, "a1", "A", "")

	d.AddPeer(p)

	if d.GroupCount() != 0 {
		t.Errorf("expected 0 groups for empty IP, got %d", d.GroupCount())
	}

	lanPeers := d.GetLANPeers(p)
	if len(lanPeers) != 0 {
		t.Errorf("expected 0 LAN peers for empty IP, got %d", len(lanPeers))
	}
}
