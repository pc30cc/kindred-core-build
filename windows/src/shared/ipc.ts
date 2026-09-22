// The contract between the renderer and the main process.
//
// Every HTTP request the app makes goes through the main process. The API
// only hands a Bearer session to a client that sends no `Origin` header
// (server/routes/auth.ts), which a page in a browser window always does —
// so the renderer asks, and Node does the talking. It also keeps the session
// token out of the renderer entirely: it is read, encrypted and attached here.

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface ApiRequest {
  method: HttpMethod
  path: string
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  /** `json` (default) decodes the body, `none` only checks the status, `bytes` returns raw data. */
  responseType?: 'json' | 'none' | 'bytes'
  timeoutMs?: number
}

export type ApiFailureKind = 'unauthorized' | 'transport' | 'server' | 'decoding'

export type ApiResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; kind: ApiFailureKind; status?: number; message?: string; body?: unknown }

export interface LoginResult {
  user: unknown
}

export interface AppInfo {
  version: string
  platform: string
  apiOrigin: string
  isSample: boolean
  supportUrl: string | null
}

export interface DesktopSettings {
  /** Launch with Windows, minimized to the tray. */
  openAtLogin: boolean
  /** Closing the window keeps the app running in the tray, so notifications still arrive. */
  closeToTray: boolean
  /** Show Windows notifications for new messages. */
  desktopNotifications: boolean
  /** Play the notification chime. */
  notificationSound: boolean
}

export interface NotifyRequest {
  title: string
  body: string
  silent?: boolean
  /** Handed back to the renderer when the notification is clicked. */
  payload?: { kind: 'conversation' | 'colleague' | 'email'; id: string; workspaceId?: string }
}

export interface TitleBarTheme {
  color: string
  symbolColor: string
  background: string
}

export interface SaveFileRequest {
  fileName: string
  data: Uint8Array
}

export interface OpenFileResult {
  name: string
  mimeType: string
  data: Uint8Array
}

export interface WebyarBridge {
  api: {
    request<T = unknown>(req: ApiRequest): Promise<ApiResult<T>>
    login(email: string, password: string): Promise<ApiResult<LoginResult>>
    logout(): Promise<ApiResult<null>>
    discardSession(): Promise<void>
    hasToken(): Promise<boolean>
    refreshOrigin(): Promise<void>
    setServer(origin: string | null): Promise<string>
  }
  app: {
    info(): Promise<AppInfo>
    getSettings(): Promise<DesktopSettings>
    setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>
    openExternal(url: string): Promise<void>
    notify(req: NotifyRequest): Promise<void>
    setBadge(count: number, overlayDataUrl: string | null): Promise<void>
    setTitleBarTheme(theme: TitleBarTheme): Promise<void>
    saveFile(req: SaveFileRequest): Promise<boolean>
    openFileWith(req: SaveFileRequest): Promise<boolean>
    pickFiles(): Promise<OpenFileResult[]>
    isFocused(): Promise<boolean>
    focus(): Promise<void>
    onNotificationClick(cb: (payload: NonNullable<NotifyRequest['payload']>) => void): () => void
    onFocusChange(cb: (focused: boolean) => void): () => void
  }
}
