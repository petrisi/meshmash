import { readFileSync } from 'node:fs'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// Production builds only: the dev server needs inline scripts and a websocket for HMR.
// The page needs nothing beyond its own files and OpenStreetMap tiles, plus the local
// meshmash-bridge when built with VITE_BRIDGE=1.
const csp = (bridge: boolean): Plugin => {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://tile.openstreetmap.org",
    `connect-src 'self'${bridge ? ' ws://127.0.0.1:* ws://localhost:*' : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return {
    name: 'csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const bridge = loadEnv(mode, process.cwd(), 'VITE_').VITE_BRIDGE === '1'
  return {
    plugins: [svelte(), csp(bridge)],
    define: { __APP_VERSION__: JSON.stringify(version), __BRIDGE__: JSON.stringify(bridge) },
  }
})
