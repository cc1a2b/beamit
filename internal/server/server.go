package server

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/hassan/beamit/internal/signaling"
)

// Config holds the server configuration.
type Config struct {
	Host         string
	Port         int
	TURNPort     int
	TURNSecret   string
	TURNPublicIP string
	DevMode      bool
	TLSCert      string
	TLSKey       string
}

// Server is the main BeamIt HTTP + WebSocket server.
type Server struct {
	config     Config
	hub        *signaling.Hub
	httpServer *http.Server
	webFS      fs.FS
}

// New creates a new Server with the given config and embedded web assets.
func New(cfg Config, webAssets fs.FS) (*Server, error) {
	hub := signaling.NewHub()

	s := &Server{
		config: cfg,
		hub:    hub,
		webFS:  webAssets,
	}

	mux := s.buildMux()

	s.httpServer = &http.Server{
		Addr:         fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	return s, nil
}

// buildMux sets up the HTTP router with all middleware and handlers.
func (s *Server) buildMux() http.Handler {
	mux := http.NewServeMux()

	// WebSocket endpoint.
	mux.HandleFunc("/ws", s.handleWebSocket)

	// Health check endpoint.
	mux.HandleFunc("/health", s.handleHealth)

	// TURN credentials endpoint.
	mux.HandleFunc("/api/turn", s.handleTURN)

	// Static file server for embedded web assets.
	fileServer := http.FileServer(http.FS(s.webFS))
	mux.Handle("/", fileServer)

	// Apply middleware chain.
	var handler http.Handler = mux

	// Rate limiter: 100 requests per minute per IP for HTTP, WebSocket has its own limits.
	rl := newRateLimiter(100, time.Minute)
	handler = rateLimitMiddleware(rl)(handler)

	if s.config.DevMode {
		handler = corsHeaders(handler)
	}

	handler = securityHeaders(handler)
	handler = requestLogger(handler)

	return handler
}

// Start begins serving HTTP requests and runs the signaling hub.
func (s *Server) Start() error {
	go s.hub.Run()

	addr := fmt.Sprintf("%s:%d", s.config.Host, s.config.Port)
	slog.Info("BeamIt server starting",
		"addr", addr,
		"dev_mode", s.config.DevMode,
	)

	if s.config.TLSCert != "" && s.config.TLSKey != "" {
		slog.Info("TLS enabled", "cert", s.config.TLSCert)
		return s.httpServer.ListenAndServeTLS(s.config.TLSCert, s.config.TLSKey)
	}

	return s.httpServer.ListenAndServe()
}

// Shutdown gracefully shuts down the server.
func (s *Server) Shutdown(ctx context.Context) error {
	slog.Info("shutting down BeamIt server")
	return s.httpServer.Shutdown(ctx)
}

// Hub returns the signaling hub (for testing).
func (s *Server) Hub() *signaling.Hub {
	return s.hub
}
