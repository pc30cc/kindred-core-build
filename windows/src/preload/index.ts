import { contextBridge, ipcRenderer } from 'electron'
import type { WebyarBridge } from '../shared/ipc'

const bridge: WebyarBridge = {
  api: {
    request: (req) => ipcRenderer.invoke('api:request', req),
    login: (email, password) => ipcRenderer.invoke('api:login', email, password),
    logout: () => ipcRenderer.invoke('api:logout'),
    discardSession: () => ipcRenderer.invoke('api:discard'),
    hasToken: () => ipcRenderer.invoke('api:hasToken'),
    refreshOrigin: () => ipcRenderer.invoke('api:refreshOrigin'),
    setServer: (origin) => ipcRenderer.invoke('api:setServer', origin),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    getSettings: () => ipcRenderer.invoke('app:getSettings'),
    setSettings: (patch) => ipcRenderer.invoke('app:setSettings', patch),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    windowsNotificationsEnabled: () => ipcRenderer.invoke('app:windowsNotificationsEnabled'),
    openWindowsNotificationSettings: () => ipcRenderer.invoke('app:openWindowsNotificationSettings'),
    updateState: () => ipcRenderer.invoke('app:updateState'),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
    notify: (req) => ipcRenderer.invoke('app:notify', req),
    setBadge: (count, overlay) => ipcRenderer.invoke('app:setBadge', count, overlay),
    setTitleBarTheme: (theme) => ipcRenderer.invoke('app:setTitleBarTheme', theme),
    saveFile: (req) => ipcRenderer.invoke('app:saveFile', req),
    openFileWith: (req) => ipcRenderer.invoke('app:openFileWith', req),
    pickFiles: () => ipcRenderer.invoke('app:pickFiles'),
    isFocused: () => ipcRenderer.invoke('app:isFocused'),
    focus: () => ipcRenderer.invoke('app:focus'),
    onNotificationClick: (cb) => {
      const listener = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload)
      ipcRenderer.on('app:notification-click', listener)
      return () => ipcRenderer.removeListener('app:notification-click', listener)
    },
    onFocusChange: (cb) => {
      const listener = (_e: unknown, focused: boolean) => cb(focused)
      ipcRenderer.on('app:focus', listener)
      return () => ipcRenderer.removeListener('app:focus', listener)
    },
    onUpdateState: (cb) => {
      const listener = (_e: unknown, state: Parameters<typeof cb>[0]) => cb(state)
      ipcRenderer.on('app:update-state', listener)
      return () => ipcRenderer.removeListener('app:update-state', listener)
    },
  },
}

contextBridge.exposeInMainWorld('webyar', bridge)
