package turn

// Config holds TURN server configuration.
type Config struct {
	Port      int
	PublicIP  string
	Realm     string
	Secret    string
	Enabled   bool
}

// DefaultConfig returns the default TURN configuration.
func DefaultConfig() Config {
	return Config{
		Port:    3478,
		Realm:   "beamit",
		Enabled: true,
	}
}
