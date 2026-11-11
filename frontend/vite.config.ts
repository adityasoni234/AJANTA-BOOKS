/// <reference types="vitest/config" />
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { backendDevServer } from './vite-plugin-backend'

// `npm run dev` also starts the backend on API_PORT. Setting VITE_API_PROXY points the frontend at a backend
// that is run separately instead (the E2E tests do this), and then nothing is started here.
const API_PORT = 8765
const external = process.env.VITE_API_PROXY
const apiTarget = external ?? `http://127.0.0.1:${API_PORT}`

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(external ? [] : [backendDevServer({ port: API_PORT })])],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5199,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          radix: [
            '@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-select',
            '@radix-ui/react-tabs', '@radix-ui/react-popover', '@radix-ui/react-tooltip',
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
})
