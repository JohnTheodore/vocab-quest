import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy /api/* requests to the Express server
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        proxyTimeout: 120000,  // 2 min — Claude API calls can be slow
        timeout: 120000,
      },
      // Proxy auth pages to Express (server-rendered HTML)
      '/setup': { target: 'http://localhost:3001', changeOrigin: true },
      '/login': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
})
