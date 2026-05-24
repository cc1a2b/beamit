# BeamIt

<div align="center">

[![License](https://img.shields.io/github/license/cc1a2b/beamit?style=flat&color=blue)](LICENSE)
[![Go Version](https://img.shields.io/badge/Go-1.22+-00ADD8?style=flat&logo=go)](https://golang.org)
[![Release](https://img.shields.io/github/v/release/cc1a2b/beamit?style=flat&color=7c3aed)](https://github.com/cc1a2b/beamit/releases)
[![Go Report Card](https://goreportcard.com/badge/github.com/cc1a2b/beamit?style=flat)](https://goreportcard.com/report/github.com/cc1a2b/beamit)
[![Binary Size](https://img.shields.io/badge/binary_size-6.5MB-brightgreen?style=flat)](https://github.com/cc1a2b/beamit/releases)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](https://github.com/cc1a2b/beamit/releases)

**⚡ Share Files Between Any Devices — No App, No Signup, No Limits**

*One 6.5MB Go binary. Browser-based. WebRTC P2P with E2E encryption. Works across any networks, anywhere.*

</div>

## 📖 About

**BeamIt** is an open-source, instant file sharing tool that lets anyone share files between ANY devices, ANYWHERE — same room or different countries — using only a web browser. One 6.5MB Go binary. Zero configuration. Just run it. Same-network devices auto-discover; cross-network pairs use a short shareable code. Transfers prefer WebRTC P2P, fall back through TURN, then WebSocket relay — every path stays end-to-end encrypted.

<div align="center">
<img alt="BeamIt Screenshot" src="https://github.com/user-attachments/assets/859da738-20f8-4d21-b3f0-8e6a312c42dd" width="100%">

*BeamIt — drag a file, drop on a device, instant encrypted P2P transfer.*
</div>

---

## 📑 Table of Contents

- [About](#-about)
- [Features](#-features)
- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [How It Works](#-how-it-works)
- [Usage Examples](#-usage-examples)
- [Why BeamIt](#-why-beamit)
- [Self-Hosting](#-self-hosting)
- [Contributing](#-contributing)
- [License](#-license)
- [Support](#-support)

---

## ✨ Features

### 🎯 Core Capabilities
- **🌐 Browser-Based**: Works on every device with a modern browser — no app to install, no signup
- **⚡ True P2P via WebRTC**: Direct device-to-device transfer when possible, fastest and most private
- **🔒 E2E Encrypted**: AES-256-GCM end-to-end on every path, including TURN relay
- **📡 Cross-Network**: Same room, same network, different countries — works anywhere
- **🔍 Auto-Discovery on LAN**: Devices on the same network appear automatically
- **💾 Single Binary / Self-Hostable**: 6.5MB Go binary, zero dependencies, no database
- **🚀 No File Size Limits**: Share files of any size; only your bandwidth matters
- **🌓 Dark/Light Theme**: System-aware, mobile responsive
- **📋 Text/Clipboard Sharing**: Send snippets and links alongside files
- **🔑 Room Codes**: Cross-network pairing via short codes (e.g. `BEAM-X7K2`)

### 🧠 Intelligent Connection Engine
> **Three-step strategy: P2P → TURN → relay. Always works. Always encrypted.**

```
Step 1: WebRTC P2P direct (via STUN)
        ├── ✅ Success → fastest, most private
        └── ❌ Fail (strict NAT) →
Step 2: WebRTC via TURN relay
        ├── ✅ Success → still E2E encrypted
        └── ❌ Fail (TURN blocked) →
Step 3: WebSocket relay fallback
        └── ✅ Always works. Encrypted. Slower.
```

### 🌐 Sharing Modes
<details>
<summary><strong>Same network and cross-network — both flows are first-class</strong></summary>

**Same Network (auto-discovery):**
1. Person A opens BeamIt in their browser
2. Person B opens BeamIt on another device (same network)
3. Both devices appear automatically
4. Drag file → drop on device → instant P2P transfer

**Different Networks (share a code):**
1. Person A clicks "Get a sharing code" → gets `BEAM-X7K2`
2. Sends code to Person B (text, call, whatever)
3. Person B enters code → devices paired
4. WebRTC P2P transfer, E2E encrypted

</details>

---

## 📦 Installation

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
- **6.5MB free disk** for the binary

---

## 🚀 Quick Start

```bash
./beamit
```

Open **http://localhost:8080** in your browser. Done.

---

## 🔄 How It Works

### Same Network — automatic discovery
Devices on the same LAN find each other via mDNS broadcast. Drag, drop, transfer.

### Different Networks — share a code
A short `BEAM-XXXX` code pairs two browsers across the internet. WebRTC handles NAT traversal; TURN handles strict NATs; WebSocket relay handles the rest.

### Connection strategy
P2P first (fastest). TURN second (still encrypted, slightly slower). WebSocket relay last (always works).

---

## 💡 Usage Examples

```bash
# Default — HTTP on :8080
./beamit

# Custom port
./beamit --port 9090

# Custom STUN/TURN servers
./beamit --stun stun:custom.stun.com:3478 \
         --turn turn:custom.turn.com:3478 \
         --turn-user myuser --turn-pass mypass

# Enable HTTPS with cert + key
./beamit --tls-cert cert.pem --tls-key key.pem

# Bind to a specific interface
./beamit --host 192.168.1.10 --port 8080
```

---

## 🏆 Why BeamIt

| Tool | Browser-based | Cross-network | True P2P | Simple UX | Single binary | Self-host | No limits |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **BeamIt** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| LocalSend | ❌ (app) | ❌ (LAN only) | ✅ | ✅ | ❌ | ❌ | ✅ |
| PairDrop | ✅ | ⚠️ | ⚠️ (relay) | ❌ | ❌ (Node.js) | ✅ | ✅ |
| ShareDrop | ✅ | ❌ (LAN only) | ✅ | ✅ | ❌ | ✅ | ✅ |
| FilePizza | ✅ | ✅ | ✅ | ⚠️ | ❌ | ✅ | ⚠️ |
| wormhole.app | ✅ | ✅ | ❌ (cloud) | ✅ | ❌ | ❌ | ❌ (10GB) |
| Magic Wormhole | ❌ (CLI) | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |

**BeamIt is the only tool that does all 7.**

---

## 🏠 Self-Hosting

```bash
# Run on your own VPS
./beamit --host 0.0.0.0 --port 80 \
         --tls-cert /etc/letsencrypt/live/share.example.com/fullchain.pem \
         --tls-key /etc/letsencrypt/live/share.example.com/privkey.pem

# With a public TURN server for strict-NAT users
./beamit --turn turn:turn.example.com:3478 \
         --turn-user myuser --turn-pass mypass
```

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

## 🤝 Contributing

Contributions welcome from the open-source community.

- **🐛 Report bugs** via [GitHub Issues](https://github.com/cc1a2b/beamit/issues)
- **💡 Suggest features** that respect the no-signup, no-app philosophy
- **📝 Improve documentation**
- **🔧 Submit pull requests** for new transports, UI improvements, or self-host docs

### Development Setup
```bash
git clone https://github.com/cc1a2b/beamit.git
cd beamit
go mod tidy
make build
```

---

## 📄 License

BeamIt is released under the **MIT License**. See [LICENSE](https://github.com/cc1a2b/beamit/blob/main/LICENSE) for details.

```
Copyright (c) 2024-2026 Hussain Alsharman
Licensed under MIT License — free for commercial and personal use
```

---

## ☕ Support

If BeamIt makes file sharing easier:

<div align="center">

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/default-orange.png)](https://www.buymeacoffee.com/cc1a2b)

**⭐ Star this repo** • **🐦 Follow [@cc1a2b](https://twitter.com/cc1a2b)** • **📢 Share with everyone**

</div>

---

<div align="center">

**⚡ BeamIt — Share Files Between Any Devices**

*Built with ❤️ by [cc1a2b](https://github.com/cc1a2b) for the open web*

</div>
