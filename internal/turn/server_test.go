package turn

import (
	"strings"
	"testing"
	"time"
)

func TestGenerateCredentials(t *testing.T) {
	cfg := Config{
		Port:     3478,
		PublicIP: "203.0.113.1",
		Realm:    "beamit",
		Secret:   "test-secret-key",
	}

	creds, err := GenerateCredentials(cfg, "peer123")
	if err != nil {
		t.Fatalf("GenerateCredentials error: %v", err)
	}

	if creds.Username == "" {
		t.Error("expected non-empty username")
	}
	if creds.Password == "" {
		t.Error("expected non-empty password")
	}
	if creds.TTL <= 0 {
		t.Errorf("expected positive TTL, got %d", creds.TTL)
	}
	if len(creds.URIs) != 2 {
		t.Errorf("expected 2 URIs, got %d", len(creds.URIs))
	}

	// Check username format: "timestamp:clientID"
	if !strings.Contains(creds.Username, ":peer123") {
		t.Errorf("expected username to contain ':peer123', got '%s'", creds.Username)
	}

	// Check URIs
	for _, uri := range creds.URIs {
		if !strings.Contains(uri, "203.0.113.1") {
			t.Errorf("expected URI to contain public IP, got '%s'", uri)
		}
		if !strings.Contains(uri, "3478") {
			t.Errorf("expected URI to contain port, got '%s'", uri)
		}
	}
}

func TestGenerateCredentials_NoSecret(t *testing.T) {
	cfg := Config{
		Port:     3478,
		PublicIP: "203.0.113.1",
	}

	_, err := GenerateCredentials(cfg, "peer123")
	if err == nil {
		t.Error("expected error when secret is empty")
	}
}

func TestValidateCredentials(t *testing.T) {
	cfg := Config{
		Secret: "test-secret-key",
	}

	creds, err := GenerateCredentials(Config{
		Port:     3478,
		PublicIP: "203.0.113.1",
		Secret:   "test-secret-key",
	}, "peer123")
	if err != nil {
		t.Fatalf("GenerateCredentials error: %v", err)
	}

	// Valid credentials should pass.
	if !ValidateCredentials(cfg, creds.Username, creds.Password) {
		t.Error("expected valid credentials to pass validation")
	}

	// Wrong password should fail.
	if ValidateCredentials(cfg, creds.Username, "wrong-password") {
		t.Error("expected wrong password to fail validation")
	}

	// Wrong username should fail.
	if ValidateCredentials(cfg, "wrong-username", creds.Password) {
		t.Error("expected wrong username to fail validation")
	}
}

func TestValidateCredentials_Expired(t *testing.T) {
	cfg := Config{
		Secret: "test-secret-key",
	}

	// Create credentials with a past timestamp.
	expired := time.Now().Add(-1 * time.Hour).Unix()
	username := "0:peer123" // timestamp 0, long expired
	_ = expired

	if ValidateCredentials(cfg, username, "anything") {
		t.Error("expected expired credentials to fail validation")
	}
}

func TestValidateCredentials_NoSecret(t *testing.T) {
	cfg := Config{}

	if ValidateCredentials(cfg, "user", "pass") {
		t.Error("expected validation to fail with no secret")
	}
}

func TestSplitFirst(t *testing.T) {
	tests := []struct {
		input    string
		sep      byte
		expected []string
	}{
		{"a:b:c", ':', []string{"a", "b:c"}},
		{"hello", ':', []string{"hello"}},
		{":test", ':', []string{"", "test"}},
	}

	for _, tt := range tests {
		result := splitFirst(tt.input, tt.sep)
		if len(result) != len(tt.expected) {
			t.Errorf("splitFirst(%q, %c) = %v, want %v", tt.input, tt.sep, result, tt.expected)
			continue
		}
		for i := range result {
			if result[i] != tt.expected[i] {
				t.Errorf("splitFirst(%q, %c)[%d] = %q, want %q", tt.input, tt.sep, i, result[i], tt.expected[i])
			}
		}
	}
}
