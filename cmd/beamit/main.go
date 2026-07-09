package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hassan/beamit/internal/server"
	"github.com/hassan/beamit/internal/turn"
	"github.com/hassan/beamit/web"
)

var (
	version   = "dev"
	buildTime = "unknown"
)

func main() {
	var cfg server.Config
	var showVersion bool
	var logLevel string
	var turnIP string

	flag.StringVar(&cfg.Host, "host", "0.0.0.0", "Host to bind to")
	flag.IntVar(&cfg.Port, "port", 8080, "HTTP port")
	flag.IntVar(&cfg.TURNPort, "turn-port", 3478, "TURN server port")
	flag.StringVar(&cfg.TURNSecret, "turn-secret", "", "TURN authentication secret (enables built-in TURN server)")
	flag.StringVar(&turnIP, "turn-ip", "", "TURN server public IP (auto-detect if empty)")
	flag.BoolVar(&cfg.DevMode, "dev", false, "Enable development mode (CORS, verbose logging)")
	flag.StringVar(&cfg.TLSCert, "tls-cert", "", "Path to TLS certificate file")
	flag.StringVar(&cfg.TLSKey, "tls-key", "", "Path to TLS private key file")
	flag.BoolVar(&showVersion, "version", false, "Show version and exit")
	flag.StringVar(&logLevel, "log-level", "info", "Log level (debug, info, warn, error)")
	flag.Parse()

	if showVersion {
		fmt.Printf("beamit %s (built %s)\n", version, buildTime)
		os.Exit(0)
	}

	// Configure structured logging.
	var level slog.Level
	switch logLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	if cfg.DevMode {
		level = slog.LevelDebug
	}

	handler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	slog.SetDefault(slog.New(handler))

	// Set TURN public IP in config for the /api/turn endpoint.
	cfg.TURNPublicIP = turnIP

	// Create and start the server.
	srv, err := server.New(cfg, web.Assets)
	if err != nil {
		slog.Error("failed to create server", "error", err)
		os.Exit(1)
	}

	// Start built-in TURN server if secret is provided.
	var turnServer *turn.Server
	if cfg.TURNSecret != "" {
		turnCfg := turn.Config{
			Port:     cfg.TURNPort,
			PublicIP: turnIP,
			Realm:    "beamit",
			Secret:   cfg.TURNSecret,
			Enabled:  true,
		}
		turnServer, err = turn.NewServer(turnCfg)
		if err != nil {
			slog.Error("failed to start TURN server", "error", err)
			os.Exit(1)
		}
		defer turnServer.Close()
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		if err := srv.Start(); err != nil && err.Error() != "http: Server closed" {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	turnStatus := "disabled"
	if cfg.TURNSecret != "" {
		turnStatus = fmt.Sprintf("enabled (:%d)", cfg.TURNPort)
	}

	fmt.Printf(`
  ⚡ BeamIt v%s

  Share files between any devices.
  No app. No signup. No limits.

  → http://%s:%d
  TURN: %s

  Press Ctrl+C to stop.

`, version, displayHost(cfg.Host), cfg.Port, turnStatus)

	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("shutdown error", "error", err)
		os.Exit(1)
	}

	slog.Info("BeamIt server stopped")
}

func displayHost(host string) string {
	if host == "0.0.0.0" || host == "" {
		return "localhost"
	}
	return host
}
