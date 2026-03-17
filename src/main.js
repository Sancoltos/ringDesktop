const { app, BrowserWindow, ipcMain, shell, screen } = require('electron')
const path   = require('path')
const fs     = require('fs')
const http   = require('http')
const os     = require('os')
const { spawn } = require('child_process')

// ── PATHS ──
const TOKEN_FILE     = path.join(os.homedir(), '.ring-desktop-token.json')
const HLS_DIR        = path.join(os.tmpdir(), 'ring-desktop-hls')
const RECORDINGS_DIR = path.join(os.homedir(), 'Desktop', 'Ring Recordings')

// Create dirs on startup
for (const d of [HLS_DIR, RECORDINGS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

// ── TOKEN STORAGE ──
function saveToken(t)  { try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: t }), 'utf8') } catch(e){} }
function loadToken()   { try { return JSON.parse(fs.readFileSync(TOKEN_FILE,'utf8')).token } catch(e){ return null } }
function clearToken()  { try { fs.unlinkSync(TOKEN_FILE) } catch(e){} }

// ── STATE ──
let mainWindow   = null
let popupWindow  = null
let ringApi      = null
let pendingApi   = null   // held between 1st login and 2FA submission
let cameras      = []
let activeFFmpeg = {}
let motionSubs   = {}
let hlsPort      = null

// ════════════════════════════════════════
//  WINDOWS
// ════════════════════════════════════════

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 780, minWidth: 800, minHeight: 600,
    backgroundColor: '#0a0a0f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

function createPopupWindow(cameraName, eventType) {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('camera-update', { cameraName, eventType })
    return
  }
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize
  const W = 380, H = 260, M = 16
  popupWindow = new BrowserWindow({
    width: W, height: H, x: sw - W - M, y: M,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  popupWindow.loadFile(path.join(__dirname, 'popup.html'))
  popupWindow.once('ready-to-show', () => {
    popupWindow.show()
    popupWindow.webContents.send('camera-update', { cameraName, eventType })
  })
  popupWindow.on('closed', () => { popupWindow = null; stopAllStreams() })
}

// ════════════════════════════════════════
//  HLS FILE SERVER
// ════════════════════════════════════════

const hlsServer = http.createServer((req, res) => {
  const filePath = path.join(HLS_DIR, req.url.replace(/^\/hls\//, ''))
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return }
    const ext = path.extname(filePath)
    const ct  = ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/MP2T'
    res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' })
    res.end(data)
  })
})
hlsServer.listen(0, '127.0.0.1', () => {
  hlsPort = hlsServer.address().port
  console.log(`[hls-server] port ${hlsPort}`)
})

// ════════════════════════════════════════
//  FFMPEG STREAMING (HLS)
// ════════════════════════════════════════

const ffmpegPath = require('ffmpeg-static')

async function startStream(camera) {
  const id = String(camera.data.device_id)
  stopStream(id)

  const outDir = path.join(HLS_DIR, id)
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const playlist = path.join(outDir, 'live.m3u8')

  try {
    const session = await camera.startLiveCall()
    activeFFmpeg[id] = session

    await session.startTranscoding({
      ffmpegPath,
      video: ['-f', 'hls', '-hls_time', '2', '-hls_list_size', '6', '-hls_flags', 'delete_segments+append_list', '-hls_segment_filename', path.join(outDir, 'seg%03d.ts'), playlist],
      audio: [],
    })

    console.log(`[stream] started cam ${id}`)
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('stream-ready', `/hls/${id}/live.m3u8`)
    }

    session.onCallEnded.subscribe(() => {
      console.log(`[stream] ended cam ${id}`)
      delete activeFFmpeg[id]
    })
  } catch(err) {
    console.error('[stream] error:', err)
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('stream-error', err.message)
    }
  }
}

function stopStream(id) {
  if (activeFFmpeg[id]) {
    try { activeFFmpeg[id].stop() } catch(e){}
    delete activeFFmpeg[id]
  }
}
function stopAllStreams() { Object.keys(activeFFmpeg).forEach(stopStream) }

// ════════════════════════════════════════
//  MOTION CLIP SAVER (10s MP4)
// ════════════════════════════════════════

let savingClips = new Set()

async function saveMotionClip(camera) {
  const id = String(camera.data.device_id)
  if (savingClips.has(id)) return
  savingClips.add(id)

  const name     = camera.data.description || camera.data.kind || 'Camera'
  const safeName = name.replace(/[^a-z0-9]/gi, '_')
  const now      = new Date()
  const stamp    = now.toISOString().replace(/[:.]/g, '-').replace('T','_').slice(0,19)
  const outFile  = path.join(RECORDINGS_DIR, `${stamp}_${safeName}.mp4`)

  console.log(`[clip] saving 10s clip → ${outFile}`)

  try {
    const session = await camera.startLiveCall()

    await session.startTranscoding({
      ffmpegPath,
      video: ['-t', '10', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-movflags', '+faststart', outFile],
      audio: ['-c:a', 'aac'],
    })

    console.log(`[clip] transcoding started`)

    setTimeout(async () => {
      try { await session.stop() } catch(e) {}
      savingClips.delete(id)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('clip-saved', {
          file:   outFile,
          camera: name,
          time:   now.toISOString(),
        })
      }
      console.log(`[clip] saved → ${outFile}`)
    }, 12000)
  } catch(err) {
    console.error('[clip] error:', err)
    savingClips.delete(id)
  }
}

// ════════════════════════════════════════
//  MOTION / DING LISTENERS
// ════════════════════════════════════════

function startMotionListeners() {
  cameras.forEach(cam => {
    const id = String(cam.data.device_id)
    if (motionSubs[id]) return

    const motionSub = cam.onMotionDetected.subscribe(detected => {
      if (!detected) return
      const name = cam.data.description || cam.data.kind || 'Camera'
      console.log(`[motion] ${name}`)

      createPopupWindow(name, 'motion')
      setTimeout(() => startStream(cam), 1200)
      saveMotionClip(cam)

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('motion-event', { name, id })
      }
    })

    const dingSub = cam.onDoorbellPressed.subscribe(ding => {
      if (!ding) return
      const name = cam.data.description || cam.data.kind || 'Camera'
      console.log(`[ding] ${name}`)

      createPopupWindow(name, 'ding')
      setTimeout(() => startStream(cam), 1200)
      saveMotionClip(cam)

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ding-event', { name, id })
      }
    })

    motionSubs[id] = { motionSub, dingSub }
  })
}

function stopMotionListeners() {
  Object.values(motionSubs).forEach(({ motionSub, dingSub }) => {
    try { motionSub.unsubscribe() } catch(e){}
    try { dingSub.unsubscribe()   } catch(e){}
  })
  motionSubs = {}
}

// ════════════════════════════════════════
//  IPC HANDLERS
// ════════════════════════════════════════

ipcMain.handle('get-saved-token',   () => loadToken())
ipcMain.handle('get-hls-port',      () => hlsPort)
ipcMain.handle('get-recordings-dir',() => RECORDINGS_DIR)

// ── LOGIN WITH EMAIL/PASSWORD/2FA ──
ipcMain.handle('login', async (_, { email, password, twoFactorCode }) => {
  try {
    const { RingApi } = require('ring-client-api')

    if (twoFactorCode && pendingApi) {
      // Step 2: complete 2FA using the same restClient that triggered the SMS
      // ring-client-api's getAuth(code) sends email+password+2fa-code header to Ring OAuth
      const auth = await pendingApi.restClient.getAuth(twoFactorCode)
      const refreshToken = auth.refresh_token

      // Build a normal RingApi from the obtained refresh token
      const api = new RingApi({ refreshToken, controlCenterDisplayName: 'Ring Desktop' })
      api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => saveToken(newRefreshToken))

      cameras = await api.getCameras()
      ringApi = api
      pendingApi = null
      saveToken(refreshToken)
      startMotionListeners()
      return { ok: true, count: cameras.length }
    }

    // Step 1: first login attempt — create instance and trigger auth
    const api = new RingApi({ email, password, controlCenterDisplayName: 'Ring Desktop' })
    pendingApi = api   // keep alive so step 2 can reuse the same restClient

    // getCameras() triggers auth; throws if 2FA is required
    cameras = await api.getCameras()

    // No 2FA needed — we're done
    api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => saveToken(newRefreshToken))
    ringApi = api
    pendingApi = null
    startMotionListeners()
    return { ok: true, count: cameras.length }
  } catch(err) {
    const msg = err.message || ''
    // Ring signals 2FA required via a specific error message
    if (
      msg.includes('2-factor') ||
      msg.includes('Two factor') ||
      msg.includes('two factor') ||
      msg.includes('2fa') ||
      msg.includes('verification code') ||
      msg.includes('OTP') ||
      msg.includes('Verification Code')
    ) {
      return { ok: false, needs2fa: true, error: '2FA code required' }
    }
    pendingApi = null
    return { ok: false, error: msg }
  }
})

// ── CONNECT WITH SAVED TOKEN ──
ipcMain.handle('connect-token', async (_, token) => {
  try {
    const { RingApi } = require('ring-client-api')
    ringApi = new RingApi({ refreshToken: token, controlCenterDisplayName: 'Ring Desktop' })
    ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => saveToken(newRefreshToken))
    cameras = await ringApi.getCameras()
    saveToken(token)
    startMotionListeners()
    return { ok: true, count: cameras.length }
  } catch(err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle('disconnect', () => {
  stopMotionListeners()
  stopAllStreams()
  ringApi    = null
  pendingApi = null
  cameras    = []
  clearToken()
  return { ok: true }
})

ipcMain.handle('get-cameras', async () => {
  if (!ringApi) return []
  cameras = await ringApi.getCameras()
  return cameras.map(c => ({
    id:      c.data.device_id,
    name:    c.data.description || c.data.kind || 'Camera',
    kind:    c.data.kind,
    battery: c.data.battery_life,
  }))
})

ipcMain.handle('get-snapshot', async (_, cameraId) => {
  const cam = cameras.find(c => String(c.data.device_id) === String(cameraId))
  if (!cam) return null
  try { return (await cam.getSnapshot()).toString('base64') } catch(e) { return null }
})

ipcMain.handle('get-events', async (_, cameraId) => {
  const targets = cameraId
    ? cameras.filter(c => String(c.data.device_id) === String(cameraId))
    : cameras
  let all = []
  for (const cam of targets) {
    try {
      const res = await cam.getEvents({ limit: 40 })
      const evs = res.events || res || []
      // if (evs.length) console.log('[event sample]', JSON.stringify(evs[0], null, 2))
      all.push(...evs.map(e => ({
        ...e,
        cameraName: cam.data.description || cam.data.kind || 'Camera',
        cameraId:   cam.data.device_id,
      })))
    } catch(e){}
  }
  all.sort((a,b) => (b.created_at||0) - (a.created_at||0))
  return all
})

ipcMain.handle('get-recording-url', async (_, dingId) => {
  console.log('[recording] looking up:', dingId)
  for (const cam of cameras) {
    try {
      const url = await cam.getRecordingUrl(dingId, { transcoded: true })
      console.log('[recording] got url:', url)
      if (url) return url
    } catch(e) {
      console.log('[recording] error:', e.message)
    }
  }
  console.log('[recording] nothing found')
  return null
})

// ── RECORDINGS FOLDER ──
ipcMain.handle('get-saved-clips', () => {
  try {
    return fs.readdirSync(RECORDINGS_DIR)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const full = path.join(RECORDINGS_DIR, f)
        const stat = fs.statSync(full)
        return { file: f, path: full, size: stat.size, mtime: stat.mtimeMs }
      })
      .sort((a,b) => b.mtime - a.mtime)
  } catch(e) { return [] }
})

ipcMain.on('open-url',         (_, url) => shell.openExternal(url))
ipcMain.on('open-file',        (_, p)   => shell.openPath(p))
ipcMain.on('open-recordings',  ()       => shell.openPath(RECORDINGS_DIR))
ipcMain.on('close-popup',      ()       => { if (popupWindow && !popupWindow.isDestroyed()) popupWindow.close() })
ipcMain.on('test-popup',       ()       => {
  createPopupWindow('Front Door (Test)', 'motion')
  const cam = cameras[0]
  if (cam) { setTimeout(() => startStream(cam), 1200); saveMotionClip(cam) }
})

// ── LIFECYCLE ──
app.whenReady().then(createMainWindow)
app.on('window-all-closed', () => {
  stopAllStreams()
  stopMotionListeners()
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})
