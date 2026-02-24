package relay

// The relay module handles WebSocket relay fallback for when WebRTC P2P fails.
// The actual relay logic is handled directly in the signaling hub via relay_chunk messages.
// This package provides utilities for relay configuration and metrics.

import (
	"sync/atomic"
)

// Stats tracks relay usage statistics.
type Stats struct {
	ChunksRelayed atomic.Int64
	BytesRelayed  atomic.Int64
}

// GlobalStats holds global relay statistics.
var GlobalStats Stats

// RecordChunk records a relayed chunk for metrics.
func RecordChunk(size int) {
	GlobalStats.ChunksRelayed.Add(1)
	GlobalStats.BytesRelayed.Add(int64(size))
}

// GetStats returns current relay stats.
func GetStats() (chunks int64, bytes int64) {
	return GlobalStats.ChunksRelayed.Load(), GlobalStats.BytesRelayed.Load()
}
