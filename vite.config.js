import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',  // bind to all interfaces so the port is reachable in Docker
    proxy: {
      // Proxy /api/* requests to the Express server
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        proxyTimeout: 120000,  // 2 min — Claude API calls can be slow
        timeout: 120000,
      },
    },
  },
})
