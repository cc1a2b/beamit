package turn

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"log/slog"
	"strconv"
	"time"
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
