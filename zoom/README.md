# 📹 VideoCall — Zoom-like App (Python + WebRTC)

A real-time two-user video calling web app built with Flask, Flask-SocketIO, and WebRTC.

## 🚀 Setup & Run

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Start the server
```bash
python app.py
```

### 3. Open the app
- User 1: Open `http://localhost:5000` → Click **Start New Meeting** → Copy room code → Enter Room
- User 2: Open `http://localhost:5000` → Click **Join Room** → Paste room code → Join Meeting

> **On the same machine?** Open two different browser tabs or different browsers.
> **Different devices on same network?** Use `http://<your-ip>:5000`

---

## 🌟 Features

| Feature | Status |
|---|---|
| 🎥 Video Call (WebRTC P2P) | ✅ |
| 🎤 Mute / Unmute | ✅ |
| 📹 Stop / Start Camera | ✅ |
| 🖥️ Screen Sharing | ✅ |
| 💬 In-call Chat | ✅ |
| 🔗 Room Code System | ✅ |
| 🔇 Remote mic-off indicator | ✅ |

---

## 🏗️ Architecture

```
Browser A                    Flask Server              Browser B
   |                              |                         |
   |── socket: join_room ────────>|                         |
   |<── room_joined (no peers) ───|                         |
   |                              |<── socket: join_room ───|
   |                              |──── peer_joined ───────>|  (to A)
   |                              |──── room_joined ───────>|  (to B)
   |<── peer_joined ──────────────|                         |
   |── createOffer ───────────────────────────────────────>|
   |                              |<── socket: offer ───────|
   |<──────────── offer ──────────|                         |
   |── socket: answer ───────────>|──── answer ────────────>|
   |<───────────────── ICE ───────────────────────────────>|
   |<══════════ P2P Video/Audio ══════════════════════════>|
```

## 📁 Project Structure
```
videocall/
├── app.py                  # Flask + SocketIO signaling server
├── requirements.txt
├── templates/
│   ├── index.html          # Landing page (create/join room)
│   └── room.html           # Video call room
└── static/
    ├── css/style.css       # Full UI styling
    └── js/room.js          # WebRTC + socket client logic
```

## 🔧 Tech Stack
- **Backend:** Python, Flask, Flask-SocketIO (WebSocket signaling)
- **Frontend:** HTML/CSS/JS, WebRTC (P2P video), Socket.IO client
- **STUN:** Google public STUN servers (NAT traversal)

## ⚠️ Notes
- Camera/mic permissions are required in the browser
- For production use: add TURN server for users behind strict NAT/firewalls
- HTTPS required on production (WebRTC needs secure context)
