package signaling

import (
	"log/slog"
	"sync"
)

// Discovery manages LAN auto-discovery by grouping peers by their public IP.
// Peers behind the same NAT share the same public IP, so they're likely on the same LAN.
type Discovery struct {
	// groups maps public IP → set of peer IDs
	groups map[string]map[string]*Peer
	mu     sync.RWMutex
}

// NewDiscovery creates a new Discovery instance.
func NewDiscovery() *Discovery {
	return &Discovery{
		groups: make(map[string]map[string]*Peer),
	}
}

// AddPeer adds a peer to the discovery group based on their public IP.
func (d *Discovery) AddPeer(peer *Peer) {
	if peer.PublicIP == "" {
		return
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	if _, exists := d.groups[peer.PublicIP]; !exists {
		d.groups[peer.PublicIP] = make(map[string]*Peer)
	}
	d.groups[peer.PublicIP][peer.ID] = peer

	slog.Debug("peer added to discovery group", "peer", peer.ID, "ip", peer.PublicIP, "group_size", len(d.groups[peer.PublicIP]))
}

// RemovePeer removes a peer from their discovery group.
func (d *Discovery) RemovePeer(peer *Peer) {
	if peer.PublicIP == "" {
		return
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	group, exists := d.groups[peer.PublicIP]
	if !exists {
		return
	}

	delete(group, peer.ID)

	// Clean up empty groups.
	if len(group) == 0 {
		delete(d.groups, peer.PublicIP)
	}

	slog.Debug("peer removed from discovery group", "peer", peer.ID, "ip", peer.PublicIP)
}

// GetLANPeers returns all other peers in the same discovery group (same public IP).
func (d *Discovery) GetLANPeers(peer *Peer) []*Peer {
	if peer.PublicIP == "" {
		return nil
	}

	d.mu.RLock()
	defer d.mu.RUnlock()

	group, exists := d.groups[peer.PublicIP]
	if !exists {
		return nil
	}

	peers := make([]*Peer, 0, len(group)-1)
	for id, p := range group {
		if id != peer.ID {
			peers = append(peers, p)
		}
	}
	return peers
}

// GetLANPeerInfos returns PeerInfo for all peers in the same discovery group.
func (d *Discovery) GetLANPeerInfos(peer *Peer) []PeerInfo {
	lanPeers := d.GetLANPeers(peer)
	infos := make([]PeerInfo, 0, len(lanPeers))
	for _, p := range lanPeers {
		infos = append(infos, p.Info())
	}
	return infos
}

// NotifyLANPeers sends a message to all peers on the same LAN about a new/departing peer.
func (d *Discovery) NotifyLANPeers(peer *Peer, msgType string) {
	lanPeers := d.GetLANPeers(peer)
	for _, p := range lanPeers {
		switch msgType {
		case MsgTypePeerJoined:
			p.SendMessage(MsgTypePeerJoined, peer.Info())
		case MsgTypePeerLeft:
			p.SendMessage(MsgTypePeerLeft, RoomLeftMessage{PeerID: peer.ID})
		}
	}
}

// GroupCount returns the number of discovery groups.
func (d *Discovery) GroupCount() int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return len(d.groups)
}

// PeerCount returns the total number of discovered peers.
func (d *Discovery) PeerCount() int {
	d.mu.RLock()
	defer d.mu.RUnlock()

	count := 0
	for _, group := range d.groups {
		count += len(group)
	}
	return count
}
