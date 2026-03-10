import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const appName = '差旅票据管理器（静姐专用版）'

function resolveGitShortHash() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'nogit'
  }
}

const appVersion = process.env.APP_VERSION || `v${pkg.version}-${resolveGitShortHash()}`
const appTitle = `${appName} ${appVersion}`

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'inject-app-title',
      transformIndexHtml(html) {
        return html.replace(/<title>.*<\/title>/, `<title>${appTitle}</title>`)
      },
    },
  ],
  define: {
    __APP_NAME__: JSON.stringify(appName),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
    },
  },
})
