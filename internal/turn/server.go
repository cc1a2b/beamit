package turn

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"time"

	pionTurn "github.com/pion/turn/v4"
)

// Credentials represents time-limited TURN credentials.
type Credentials struct {
	Username string   `json:"username"`
	Password string   `json:"password"`
	TTL      int      `json:"ttl"`
	URIs     []string `json:"uris"`
}

// GenerateCredentials creates time-limited TURN credentials using the shared secret.
// Uses the TURN REST API convention: username = "timestamp:random", password = HMAC-SHA1(secret, username).
func GenerateCredentials(cfg Config, clientID string) (*Credentials, error) {
	if cfg.Secret == "" {
		return nil, fmt.Errorf("TURN secret not configured")
	}

	ttl := 24 * time.Hour
	expiry := time.Now().Add(ttl).Unix()
	username := fmt.Sprintf("%d:%s", expiry, clientID)

	mac := hmac.New(sha1.New, []byte(cfg.Secret))
	if _, err := mac.Write([]byte(username)); err != nil {
		return nil, fmt.Errorf("computing HMAC: %w", err)
	}
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	uris := []string{
		fmt.Sprintf("turn:%s:%d?transport=udp", cfg.PublicIP, cfg.Port),
		fmt.Sprintf("turn:%s:%d?transport=tcp", cfg.PublicIP, cfg.Port),
	}

	slog.Debug("generated TURN credentials", "username", username, "ttl", ttl.String())

	return &Credentials{
		Username: username,
		Password: password,
		TTL:      int(ttl.Seconds()),
		URIs:     uris,
	}, nil
}

// ValidateCredentials checks if TURN credentials are valid and not expired.
func ValidateCredentials(cfg Config, username, password string) bool {
	if cfg.Secret == "" {
		return false
	}

	// Extract expiry from username (format: "timestamp:clientID").
	parts := splitFirst(username, ':')
	if len(parts) < 2 {
		return false
	}

	expiry, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return false
	}

	// Check expiry.
	if time.Now().Unix() > expiry {
		return false
	}

	// Verify HMAC.
	mac := hmac.New(sha1.New, []byte(cfg.Secret))
	if _, err := mac.Write([]byte(username)); err != nil {
		return false
	}
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(password), []byte(expected))
}

// splitFirst splits a string on the first occurrence of sep.
func splitFirst(s string, sep byte) []string {
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			return []string{s[:i], s[i+1:]}
		}
	}
	return []string{s}
}

// Server wraps a pion/turn server with HMAC-SHA1 credential validation.
type Server struct {
	cfg    Config
	server *pionTurn.Server
	conn   net.PacketConn
}

// NewServer creates and starts a TURN server on the configured UDP port.
func NewServer(cfg Config) (*Server, error) {
	if cfg.Secret == "" {
		return nil, fmt.Errorf("TURN secret is required")
	}
	if cfg.PublicIP == "" {
		return nil, fmt.Errorf("TURN public IP is required")
	}
	if cfg.Realm == "" {
		cfg.Realm = "beamit"
	}

	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	udpListener, err := net.ListenPacket("udp4", addr)
	if err != nil {
		return nil, fmt.Errorf("failed to listen on %s: %w", addr, err)
	}

	authHandler := func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
		// Validate the username format (timestamp:clientID) and check expiry.
		parts := splitFirst(username, ':')
		if len(parts) < 2 {
			slog.Debug("TURN auth: invalid username format", "username", username)
			return nil, false
		}
		expiry, parseErr := strconv.ParseInt(parts[0], 10, 64)
		if parseErr != nil {
			slog.Debug("TURN auth: invalid timestamp", "username", username)
			return nil, false
		}
		if time.Now().Unix() > expiry {
			slog.Debug("TURN auth: credentials expired", "username", username)
			return nil, false
		}

		// Compute the expected password (HMAC-SHA1 of the username with the shared secret).
		mac := hmac.New(sha1.New, []byte(cfg.Secret))
		mac.Write([]byte(username))
		key := mac.Sum(nil)

		slog.Debug("TURN auth: credentials accepted", "username", username, "src", srcAddr)
		return key, true
	}

	publicIP := net.ParseIP(cfg.PublicIP)
	if publicIP == nil {
		_ = udpListener.Close()
		return nil, fmt.Errorf("invalid TURN public IP: %s", cfg.PublicIP)
	}

	turnServer, err := pionTurn.NewServer(pionTurn.ServerConfig{
		Realm: cfg.Realm,
		AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			return authHandler(username, realm, srcAddr)
		},
		PacketConnConfigs: []pionTurn.PacketConnConfig{
			{
				PacketConn: udpListener,
				RelayAddressGenerator: &pionTurn.RelayAddressGeneratorStatic{
					RelayAddress: publicIP,
					Address:      "0.0.0.0",
				},
			},
		},
	})
	if err != nil {
		_ = udpListener.Close()
		return nil, fmt.Errorf("failed to create TURN server: %w", err)
	}

	slog.Info("TURN server started",
		"addr", addr,
		"public_ip", cfg.PublicIP,
		"realm", cfg.Realm,
	)

	return &Server{
		cfg:    cfg,
		server: turnServer,
		conn:   udpListener,
	}, nil
}

// Close gracefully shuts down the TURN server.
func (s *Server) Close() error {
	slog.Info("shutting down TURN server")
	return s.server.Close()
}
