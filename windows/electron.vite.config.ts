import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Extra update feeds this build trusts, fixed at build time (comma-separated
    // https URL prefixes). See TRUSTED_FEEDS in src/main/updater.ts.
    define: { __WEBYAR_UPDATE_FEEDS__: JSON.stringify(process.env.WEBYAR_UPDATE_FEEDS ?? '') },
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
  },
})
