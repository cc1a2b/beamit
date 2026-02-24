# BeamIt

**Share files between any devices. No app. No signup. No limits.**

BeamIt is an open-source, instant file sharing tool that lets anyone share files between ANY devices, ANYWHERE — same room or different countries — using only a web browser.

<!-- TODO: Add demo GIF -->

## Features

- **No app required** — works in any modern browser
- **Works everywhere** — same WiFi, different networks, cellular, VPN
- **True P2P** — files transfer directly between devices via WebRTC
- **E2E encrypted** — AES-256-GCM encryption, server never sees file contents
- **Zero friction** — open browser, get code, share. That's it.
- **Single binary** — one Go binary, no dependencies, no database
- **Self-hostable** — run your own instance in seconds
- **No file size limits** — stream files of any size
- **Auto-discovery** — devices on the same network find each other automatically
- **Cross-network sharing** — use a simple code to share across any network

## How It Works

### Same Network (automatic)
1. Open BeamIt on two devices connected to the same network
2. Devices discover each other automatically
3. Drag a file onto the other device's avatar
4. File transfers directly via WebRTC P2P

### Different Networks (code-based)
1. Open BeamIt and click "Share"
2. Get a code like `BEAM-X7K2`
3. Share the code with the other person
4. They enter the code — WebRTC P2P connection established
5. Transfer files directly, E2E encrypted

## Quick Start

### Download Binary
```bash
# Linux
curl -L https://github.com/hassan/beamit/releases/latest/download/beamit-linux-amd64 -o beamit
chmod +x beamit
./beamit
```

### Build from Source
```bash
git clone https://github.com/hassan/beamit.git
cd beamit
make build
./beamit
```

### Docker
```bash
docker run -p 8080:8080 -p 3478:3478/udp ghcr.io/hassan/beamit
```

## Usage

```bash
# Start with defaults (HTTP :8080, TURN :3478)
./beamit

# Custom ports
./beamit --port 9090 --turn-port 3479

# Bind to specific host
./beamit --host 0.0.0.0

# With TURN secret for production
./beamit --turn-secret "your-secret-here"

# Enable TLS
./beamit --tls --cert cert.pem --key key.pem
```

Then open `http://localhost:8080` in your browser.

## Architecture

```
Device A (Browser)  ←──WebRTC P2P──→  Device B (Browser)
         ↕ WebSocket (signaling only) ↕
              BeamIt Server (Go)
         ┌──────────────────────┐
         │  Signaling (WebSocket) │
         │  STUN/TURN Server     │
         │  Static Files (embed) │
         │  In-Memory State      │
         └──────────────────────┘
```

- **Signaling**: WebSocket for peer discovery and WebRTC negotiation
- **Transfer**: WebRTC DataChannel for P2P file transfer
- **Fallback**: Built-in TURN relay when P2P isn't possible
- **Encryption**: DTLS (WebRTC) + AES-256-GCM application layer

## Tech Stack

- **Backend**: Go (single binary with embedded frontend)
- **Frontend**: Vanilla JS + CSS (<50KB total)
- **Transfer**: WebRTC DataChannel
- **Signaling**: WebSocket
- **NAT Traversal**: Built-in STUN/TURN server
- **Encryption**: AES-256-GCM (Web Crypto API)
- **Database**: None (pure in-memory, codes expire in 10 minutes)

## Performance Budget

| Asset | Target | Actual |
|-------|--------|--------|
| index.html | <5KB | - |
| style.css | <5KB | - |
| JS (total) | <30KB | - |
| **Total page** | **<50KB** | - |
| First paint | <200ms | - |
| Interactive | <500ms | - |

## Development

```bash
# Run in development mode (live reload)
make dev

# Run tests
make test

# Build binary
make build

# Build Docker image
make docker
```

## License

MIT License — see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please read the contributing guidelines before submitting a PR.
