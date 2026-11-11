/// <reference types="vitest/config" />
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { firebaseEmulators } from './vite-plugin-firebase-emulators'

// `npm run dev` also starts the local Firebase emulators (Auth + Firestore), so development never touches the
// real project. VITE_FIREBASE_EMULATORS=false uses the real project instead (and starts nothing).
const useEmulators = process.env.VITE_FIREBASE_EMULATORS !== 'false'

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(useEmulators ? [firebaseEmulators({ project: 'ajantabooks-840e7' })] : [])],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5199,
    strictPort: true,
  },
  preview: { port: 4173 },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore'],
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
