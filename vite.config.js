import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/generate': {
        target: 'http://localhost:8002',
        changeOrigin: true,
        // SSE 스트리밍을 위해 버퍼링 비활성화
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            proxyRes.headers['x-accel-buffering'] = 'no'
          })
        },
      },
      '/download': 'http://localhost:8002',
      '/download_pcb': 'http://localhost:8002',
      '/generate_pcb': 'http://localhost:8002',
      '/generate_gerber': 'http://localhost:8002',
      '/mouser_search': 'http://localhost:8002',
      '/mouser_cart': 'http://localhost:8002',
      '/test_code': 'http://localhost:8002',
      '/test': 'http://localhost:8002',
      '/chat_edit': {
        target: 'http://localhost:8002',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            proxyRes.headers['x-accel-buffering'] = 'no'
          })
        },
      },
      '/clarify': 'http://localhost:8002',
      '/plan': 'http://localhost:8002',
    }
  }
})
