import type { WebyarBridge } from '../shared/ipc'

declare global {
  interface Window {
    webyar: WebyarBridge
  }
}

export {}
