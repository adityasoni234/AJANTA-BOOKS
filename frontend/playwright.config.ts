import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests run against a real backend + PostgreSQL. The backend web server recreates an
 * isolated *_e2e database with deterministic demo data before starting (never production).
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 8766)
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5200)
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql+psycopg://localhost:5432/ajanta_e2e'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: `sh -c "cd ../backend && ./scripts/e2e_prepare.sh && exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port ${API_PORT}"`,
      url: `http://127.0.0.1:${API_PORT}/health/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        APP_ENV: 'test', DATABASE_URL: DB, COOKIE_SECURE: 'false', LOG_JSON: 'false', LOG_LEVEL: 'WARNING',
        SECRET_KEY: 'e2e-secret-key-0123456789-abcdefghijklmnopqrstuvwxyz', LOGIN_RATE_LIMIT_PER_MINUTE: '100',
      },
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { VITE_API_PROXY: `http://127.0.0.1:${API_PORT}` },
    },
  ],
})
