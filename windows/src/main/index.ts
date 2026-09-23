import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  Tray,
} from 'electron'
import { writeFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ApiRequest, DesktopSettings, NotifyRequest, SaveFileRequest, TitleBarTheme } from '../shared/ipc'
import * as api from './api'
import { publicSettings, readSettings, writeSettings } from './settings'

const APP_ID = 'com.webyar.desktop'
const TITLE_BAR_HEIGHT = 44

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let unread = 0

// One running copy. A second launch (a shortcut, the Start menu) brings the first one
// forward instead of opening a second inbox.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

app.setAppUserModelId(APP_ID)

function iconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../build/icon.png')
}

function appIcon(): Electron.NativeImage {
  try {
    return nativeImage.createFromBuffer(readFileSync(iconPath()))
  } catch {
    return nativeImage.createEmpty()
  }
}

function restoredBounds(): Electron.Rectangle & { maximized?: boolean } {
  const saved = readSettings().bounds
  const fallback = { width: 1360, height: 880 }
  if (!saved) return fallback as Electron.Rectangle
  // A window saved on a monitor that is no longer attached must not open off-screen.
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return saved.x !== undefined && saved.y !== undefined &&
      saved.x < a.x + a.width - 100 && saved.x + saved.width > a.x + 100 &&
      saved.y >= a.y - 10 && saved.y < a.y + a.height - 100
  })
  return (visible ? saved : { ...fallback, maximized: saved.maximized }) as Electron.Rectangle & { maximized?: boolean }
}

const LOG_LIMIT = 2 * 1024 * 1024

/** `%APPDATA%\\Webyar\\logs\\renderer.log`, with one previous file kept once it grows past 2 MB. */
function writeLog(line: string): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    const file = join(dir, 'renderer.log')
    mkdirSync(dir, { recursive: true })
    try {
      if (statSync(file).size > LOG_LIMIT) renameSync(file, join(dir, 'renderer.old.log'))
    } catch {
      // No file yet.
    }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Logging must never be the thing that breaks the app.
  }
}

function createWindow(): void {
  const bounds = restoredBounds()
  const startHidden = process.argv.includes('--hidden')
  win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'Webyar',
    icon: appIcon(),
    backgroundColor: '#F4F6F9',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#5B6577', height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
    },
  })
  if ((bounds as { maximized?: boolean }).maximized) win.maximize()

  win.once('ready-to-show', () => {
    if (!startHidden) win?.show()
  })

  // Warnings and errors from the page go to a file, so a failed call or a
  // blank screen on someone's machine leaves a trail without DevTools.
  win.webContents.on('console-message', (e) => {
    const { level, message, sourceId, lineNumber } = e as unknown as { level: string; message: string; sourceId: string; lineNumber: number }
    if (level === 'warning' || level === 'error' || message.startsWith('[call]'))
      writeLog(`${level} ${message}${sourceId ? ` (${basename(sourceId)}:${lineNumber})` : ''}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => writeLog(`renderer gone: ${details.reason} (${details.exitCode})`))

  const persist = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return
    const maximized = win.isMaximized()
    const b = maximized ? readSettings().bounds ?? win.getNormalBounds() : win.getBounds()
    writeSettings({ bounds: { ...b, maximized } })
  }
  win.on('resize', persist)
  win.on('move', persist)
  win.on('maximize', persist)
  win.on('unmaximize', persist)

  win.on('close', (event) => {
    if (!quitting && readSettings().closeToTray) {
      event.preventDefault()
      win?.hide()
    }
  })
  win.on('focus', () => {
    win?.flashFrame(false)
    win?.webContents.send('app:focus', true)
  })
  win.on('blur', () => win?.webContents.send('app:focus', false))

  // Nothing inside the window ever navigates away from the app. Links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win?.webContents.getURL()) {
      event.preventDefault()
      if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function trayMenu(): Electron.Menu {
  const fa = app.getLocale().startsWith('fa')
  return Menu.buildFromTemplate([
    { label: fa ? 'باز کردن وب‌یار' : 'Open Webyar', click: showWindow },
    { type: 'separator' },
    {
      label: fa ? 'اجرا هنگام روشن شدن ویندوز' : 'Start with Windows',
      type: 'checkbox',
      checked: readSettings().openAtLogin,
      click: (item) => applySettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    {
      label: fa ? 'خروج' : 'Quit',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
}

function createTray(): void {
  const image = appIcon().resize({ width: 16, height: 16 })
  tray = new Tray(image)
  tray.setToolTip('Webyar')
  tray.setContextMenu(trayMenu())
  tray.on('click', showWindow)
}

function applySettings(patch: Partial<DesktopSettings>): DesktopSettings {
  writeSettings(patch)
  if (patch.openAtLogin !== undefined && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: patch.openAtLogin, args: ['--hidden'] })
  }
  tray?.setContextMenu(trayMenu())
  return publicSettings()
}

function registerIpc(): void {
  ipcMain.handle('api:request', (_e, req: ApiRequest) => api.request(req))
  ipcMain.handle('api:login', (_e, email: string, password: string) => api.login(email, password))
  ipcMain.handle('api:logout', () => api.logout())
  ipcMain.handle('api:discard', () => api.discardSession())
  ipcMain.handle('api:hasToken', () => api.hasToken())
  ipcMain.handle('api:refreshOrigin', () => api.refreshOrigin())
  ipcMain.handle('api:setServer', (_e, origin: string | null) => api.setServer(origin))

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    apiOrigin: api.currentOrigin(),
    isSample: api.isSample,
    supportUrl: readSettings().supportUrl ?? null,
  }))
  ipcMain.handle('app:getSettings', () => publicSettings())
  ipcMain.handle('app:setSettings', (_e, patch: Partial<DesktopSettings>) => applySettings(patch))
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^(https:|mailto:)/i.test(url)) return shell.openExternal(url)
  })
  ipcMain.handle('app:isFocused', () => win?.isFocused() ?? false)
  ipcMain.handle('app:focus', () => showWindow())

  ipcMain.handle('app:notify', (_e, req: NotifyRequest) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: req.title, body: req.body, silent: req.silent ?? false, icon: appIcon() })
    n.on('click', () => {
      showWindow()
      if (req.payload) win?.webContents.send('app:notification-click', req.payload)
    })
    n.show()
    if (!win?.isFocused()) win?.flashFrame(true)
  })

  ipcMain.handle('app:setBadge', (_e, count: number, overlay: string | null) => {
    unread = Math.max(0, count | 0)
    tray?.setToolTip(unread > 0 ? `Webyar — ${unread}` : 'Webyar')
    if (!win) return
    if (unread > 0 && overlay) {
      win.setOverlayIcon(nativeImage.createFromDataURL(overlay), String(unread))
    } else {
      win.setOverlayIcon(null, '')
    }
  })

  ipcMain.handle('app:setTitleBarTheme', (_e, theme: TitleBarTheme) => {
    if (!win) return
    try {
      win.setTitleBarOverlay({ color: theme.color, symbolColor: theme.symbolColor, height: TITLE_BAR_HEIGHT })
    } catch {
      // Not every platform has an overlay; the window still works without one.
    }
    win.setBackgroundColor(theme.background)
  })

  ipcMain.handle('app:saveFile', async (_e, req: SaveFileRequest) => {
    if (!win) return false
    const result = await dialog.showSaveDialog(win, { defaultPath: basename(req.fileName) })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, Buffer.from(req.data))
    return true
  })

  ipcMain.handle('app:openFileWith', async (_e, req: SaveFileRequest) => {
    const safe = basename(req.fileName).replace(/[^\w.\- ]+/g, '_') || 'file'
    const path = join(tmpdir(), `webyar-${Date.now()}-${safe}`)
    await writeFile(path, Buffer.from(req.data))
    const error = await shell.openPath(path)
    return error === ''
  })

  ipcMain.handle('app:pickFiles', async () => {
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images, PDF, text, audio', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'mp3', 'm4a', 'wav', 'ogg', 'webm'] },
      ],
    })
    if (result.canceled) return []
    const { readFile } = await import('node:fs/promises')
    return Promise.all(
      result.filePaths.map(async (path) => ({
        name: basename(path),
        mimeType: mimeFor(path),
        data: new Uint8Array(await readFile(path)),
      })),
    )
  })
}

function mimeFor(path: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.webm': 'audio/webm',
  }
  return map[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function configurePermissions(): void {
  // Microphone and camera for calls and voice notes, notifications for the chime —
  // and nothing else a web page could ask for.
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  configurePermissions()
  registerIpc()
  createWindow()
  createTray()
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: readSettings().openAtLogin, args: ['--hidden'] })
  }
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && quitting) app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  else showWindow()
})
