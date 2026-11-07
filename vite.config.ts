import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const VITE_PORT = 3000
// The API's port: PORT from the environment (PORT=... npm run dev gives both processes the same one), else server/.env's
// PORT, else the server's own default, so the proxy and the server cannot disagree. A PORT equal to vite's own port was
// meant for vite: the preview tool starts vite with PORT=3000, and loadEnv, which lets the environment win over the file,
// sent every request back to vite (2026-11-07). scripts/check_api_client.ts runs this file with both.
// Windows can reserve a range of ports for itself (7989-8088 here, 2026-11-07: 8080 and 8002 both), and a port in it fails
// with EACCES. netsh interface ipv4 show excludedportrange protocol=tcp lists them.
if (process.env.PORT === String(VITE_PORT)) delete process.env.PORT
const API = `http://localhost:${loadEnv('development', 'server', '').PORT || 8113}`

export default defineConfig({
  plugins: [react()],
  server: {
    port: VITE_PORT,
    // vite sends a path to the first prefix it starts with: '/generate' also serves /generate_pcb_stream and
    // /generate_gerber, '/download' also /download_pcb and /download_gerber_file (scripts/check_api_client.ts)
    proxy: {
      '/generate': {
        target: API,
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
      '/board_model': API,
      '/download': API,
      '/mouser_search': API,
      '/erc_graph': API,
      '/netlist': API,
      '/test_code': API,
      '/chat_edit': {
        target: API,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            proxyRes.headers['x-accel-buffering'] = 'no'
          })
        },
      },
      '/clarify': API,
      '/plan': API,
      '/auth': API,
      '/sessions': API,
      '/favorites': API,
      '/health': API,
      '/demo_result': API,
    }
  }
})
