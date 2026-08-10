# BeamIt

<div align="center">

[![License](https://img.shields.io/github/license/cc1a2b/beamit?style=flat&color=blue)](LICENSE)
[![Go Version](https://img.shields.io/badge/Go-1.24+-00ADD8?style=flat&logo=go)](https://golang.org)
[![Release](https://img.shields.io/github/v/release/cc1a2b/beamit?style=flat&color=7c3aed)](https://github.com/cc1a2b/beamit/releases)
[![Go Report Card](https://goreportcard.com/badge/github.com/cc1a2b/beamit?style=flat)](https://goreportcard.com/report/github.com/cc1a2b/beamit)
[![Binary Size](https://img.shields.io/badge/binary_size-6.9MB-brightgreen?style=flat)](https://github.com/cc1a2b/beamit/releases)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](https://github.com/cc1a2b/beamit/releases)

**Share Files Between Any Devices — No App, No Signup, No Limits**

*One 6.9MB Go binary. Browser-based. WebRTC P2P with E2E encryption. Works across any networks, anywhere.*

</div>

## About

**BeamIt** is an open-source, instant file sharing tool that lets anyone share files between ANY devices, ANYWHERE — same room or different countries — using only a web browser. One 6.9MB Go binary. Zero configuration. Just run it. Same-network devices auto-discover; cross-network pairs use a short shareable code, a link, or a QR code. Transfers prefer WebRTC P2P, fall back through a built-in TURN relay, then a WebSocket relay — every path stays end-to-end encrypted and is verified with a streaming SHA-256.

<div align="center">
<img alt="BeamIt Screenshot" src="https://github.com/user-attachments/assets/859da738-20f8-4d21-b3f0-8e6a312c42dd" width="100%">

*BeamIt — drag a file, drop on a device, instant encrypted P2P transfer.*
</div>

---

## Table of Contents

- [About](#about)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Usage Examples](#usage-examples)
- [Why BeamIt](#why-beamit)
- [Self-Hosting](#self-hosting)
- [Contributing](#contributing)
- [License](#license)
- [Support](#support)

---

## Features

### New in v1.1.0
- **QR codes and auto-join links**: Every sharing code renders a QR and a `https://host/#BEAM-XXXX` link. Scan the QR with a phone camera or open the link and the room joins itself — no manual code entry.
- **Unlimited-size transfers**: The receiver streams incoming chunks straight to disk with the File System Access API instead of buffering the whole file in memory, so multi-gigabyte transfers no longer exhaust the browser tab. Browsers without the API fall back to the classic in-memory download.
- **End-to-end integrity**: The sender hashes each file with a streaming SHA-256 and sends the digest in the final frame; the receiver hashes as chunks arrive and flags any mismatch. AES-256-GCM already authenticates every chunk; this catches truncation or reordering across the relay path too.
- **Installable PWA**: A service worker precaches the app shell so BeamIt opens instantly and works offline, with an in-app Install button.
- **Built-in TURN server**: `--turn-secret` starts a real TURN relay (pion/turn) with time-limited HMAC credentials, served to the browser via `/api/turn`, so strict-NAT peers stay end-to-end encrypted instead of dropping to the slower WebSocket relay.
- **Per-transfer UX**: Live speed and ETA, a cancel button, connection-mode badges (P2P / TURN / Relay), a screen wake lock so mobile transfers don't stall, and per-peer receive sessions so several peers can send at once.

### Core Capabilities
- **Browser-Based**: Works on every device with a modern browser — no app to install, no signup
- **True P2P via WebRTC**: Direct device-to-device transfer when possible, fastest and most private
- **E2E Encrypted**: AES-256-GCM with per-peer ECDH key exchange on every path, including the TURN and WebSocket relays
- **Cross-Network**: Same room, same network, different countries — works anywhere
- **Auto-Discovery on LAN**: Devices on the same network appear automatically
- **Single Binary / Self-Hostable**: 6.9MB Go binary, two dependencies (`gorilla/websocket`, `pion/turn`), no database
- **No File Size Limits**: Streams straight to disk on the receiver — only your bandwidth matters
- **Dark/Light Theme**: System-aware, mobile responsive
- **Text/Clipboard Sharing**: Send snippets and links alongside files
- **Room Codes, Links & QR**: Cross-network pairing via short codes (e.g. `BEAM-X7K2`), auto-join links, or a scannable QR

### Intelligent Connection Engine
> **Three-step strategy: P2P → TURN → relay. Always works. Always encrypted.**

```
Step 1: WebRTC P2P direct (via STUN)
        ├── Success → fastest, most private
        └── Fail (strict NAT) →
Step 2: WebRTC via TURN relay
        ├── Success → still E2E encrypted
        └── Fail (TURN blocked) →
Step 3: WebSocket relay fallback
        └── Always works. Encrypted. Slower.
```

### Sharing Modes
<details>
<summary><strong>Same network and cross-network — both flows are first-class</strong></summary>

**Same Network (auto-discovery):**
1. Person A opens BeamIt in their browser
2. Person B opens BeamIt on another device (same network)
3. Both devices appear automatically
4. Drag file → drop on device → instant P2P transfer

**Different Networks (share a code, link, or QR):**
1. Person A clicks "Get a sharing code" → gets `BEAM-X7K2`, a link, and a QR
2. A shares any of the three — the code, the `https://host/#BEAM-X7K2` link, or the QR
3. Person B enters the code, opens the link, or scans the QR → the link/QR auto-joins, no typing
4. WebRTC P2P transfer, E2E encrypted, SHA-256 verified

</details>

---

## Installation

### Pre-built Binary
```bash
# Download from releases page
curl -L https://github.com/cc1a2b/beamit/releases/latest/download/beamit-linux-amd64 -o beamit
chmod +x beamit
./beamit
```

### Build from Source
```bash
git clone https://github.com/cc1a2b/beamit.git
cd beamit
make build
./beamit
```

### Docker
```bash
docker run -p 8080:8080 -p 3478:3478/udp ghcr.io/cc1a2b/beamit
```

### System Requirements
- **Linux, macOS, or Windows** (64-bit)
- **Modern browser** (Chrome, Firefox, Safari, Edge — anything with WebRTC)
- **6.9MB free disk** for the binary

---

## Quick Start

```bash
./beamit
```

Open **http://localhost:8080** in your browser. Done.

---

## How It Works

### Same Network — automatic discovery
Devices on the same LAN find each other via mDNS broadcast. Drag, drop, transfer.

### Different Networks — share a code, link, or QR
A short `BEAM-XXXX` code pairs two browsers across the internet. The same code is also rendered as a `https://host/#BEAM-XXXX` link and a QR — opening the link or scanning the QR auto-joins the room. WebRTC handles NAT traversal; the built-in TURN relay handles strict NATs; the WebSocket relay handles the rest.

### Connection strategy
P2P first (fastest). TURN second (still encrypted, slightly slower). WebSocket relay last (always works).

---

## Usage Examples

```bash
# Default — HTTP on :8080
./beamit

# Custom port
./beamit --port 9090

# Start the built-in TURN relay (advertise your public IP)
./beamit --turn-secret "a-long-random-secret" --turn-ip 203.0.113.10 --turn-port 3478

# Enable HTTPS with cert + key
./beamit --tls-cert cert.pem --tls-key key.pem

# Development mode (CORS + verbose logging)
./beamit --dev --log-level debug

# Bind to a specific interface
./beamit --host 192.168.1.10 --port 8080
```

---

## Why BeamIt

| Tool | Browser-based | Cross-network | True P2P | Simple UX | Single binary | Self-host | No limits |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **BeamIt** | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| LocalSend | (app) | (LAN only) | | | | | |
| PairDrop | | | (relay) | | (Node.js) | | |
| ShareDrop | | (LAN only) | | | | | |
| FilePizza | | | | | | | |
| wormhole.app | | | (cloud) | | | | (10GB) |
| Magic Wormhole | (CLI) | | | | | | |

**BeamIt is the only tool that does all 7.**

---

## Self-Hosting

```bash
# Run on your own VPS
./beamit --host 0.0.0.0 --port 80 \
         --tls-cert /etc/letsencrypt/live/share.example.com/fullchain.pem \
         --tls-key /etc/letsencrypt/live/share.example.com/privkey.pem

# With the built-in TURN relay for strict-NAT users
./beamit --host 0.0.0.0 --port 8080 \
         --turn-secret "a-long-random-secret" --turn-ip 203.0.113.10
```

Open UDP `3478` (or your `--turn-port`) so the built-in TURN relay is reachable.

Behind a reverse proxy:
```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

---

## Contributing

Contributions welcome from the open-source community.

- **Report bugs** via [GitHub Issues](https://github.com/cc1a2b/beamit/issues)
- **Suggest features** that respect the no-signup, no-app philosophy
- **Improve documentation**
- **Submit pull requests** for new transports, UI improvements, or self-host docs

### Development Setup
```bash
git clone https://github.com/cc1a2b/beamit.git
cd beamit
go mod tidy
make build
```

---

## License

BeamIt is released under the **MIT License**. See [LICENSE](https://github.com/cc1a2b/beamit/blob/main/LICENSE) for details.

```
Copyright (c) 2024-2026 Hussain Alsharman
Licensed under MIT License — free for commercial and personal use
```

---

## Support

If BeamIt makes file sharing easier:

<div align="center">

**Star this repo** • **Follow [@cc1a2b](https://twitter.com/cc1a2b)** • **Share with everyone**

</div>

---

<div align="center">

**BeamIt — Share Files Between Any Devices**

*Built by [cc1a2b](https://github.com/cc1a2b) for the open web*

</div>
