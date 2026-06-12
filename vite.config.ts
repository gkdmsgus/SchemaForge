import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/generate': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        proxyTimeout: 180000,
        timeout: 180000,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            proxyRes.headers['x-accel-buffering'] = 'no'
          })
        },
      },
      '/download': 'http://localhost:8080',
      '/download_pcb': 'http://localhost:8080',
      '/generate_pcb': 'http://localhost:8080',
      '/generate_gerber': 'http://localhost:8080',
      '/mouser_search': 'http://localhost:8080',
      '/mouser_cart': 'http://localhost:8080',
      '/test_code': 'http://localhost:8080',
      '/test': 'http://localhost:8080',
      '/chat_edit': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            proxyRes.headers['x-accel-buffering'] = 'no'
          })
        },
      },
      '/clarify': 'http://localhost:8080',
      '/plan': 'http://localhost:8080',
    }
  }
})
