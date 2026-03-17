# Ring Desktop v3 

Cross-platform desktop app for Ring cameras with live popup overlay and automatic motion clip saving.

---

## Requirements

- Node.js v18+
- A Ring account

> No FFmpeg install needed — bundled automatically.

---

## Setup

```bash
npm install
npm start
```

Enter your **Ring email and password** directly in the app. If Ring asks for 2FA, it will prompt you for the code right there.

Your credentials are **never stored** — only the refresh token (a session key) is saved locally at `~/.ring-desktop-token.json`.

---

## Features

### Built-in Login
- Email, password, and 2FA handled inside the app
- No terminal commands needed
- Works for any Ring account

### Cameras
- Live snapshots from all your cameras
- Refresh individual snapshots on demand

###  Events
- Recent motion and doorbell events with timestamps
- Open Ring cloud recordings in your browser

###  Recordings (Auto-saved)
- Every motion or doorbell event automatically saves a 10-second MP4 clip
- Saved to `~/Desktop/Ring Recordings/` (created automatically on first launch)
- Filename format: `2026-03-16_14-32-05_Front_Door.mp4`
- View and open clips from the Recordings tab
- Click "Open Folder" to browse in Explorer/Finder

###  Live Popup
- Frameless overlay in the top-right corner of your screen
- Appears automatically on motion or doorbell press
- Live HLS video stream (~3–6s delay via FFmpeg)
- Always on top, draggable, stays until you close it
- TEST button to trigger it manually

---

## Building

### Windows (.exe installer)
Run on a Windows machine:
```bash
npm run build
```
Output: `dist/Ring Desktop Setup.exe`

### Mac (.dmg)
Run on a Mac:
```bash
npm run build
```
Output: `dist/Ring Desktop.dmg`

---

## Sharing with others
Just send them the built `.exe` or `.dmg`. They install it, open it, enter their own Ring credentials, and it works. No setup, no terminal.
