/**
 * Starts the FastAPI backend together with `npm run dev`, so one command runs the whole app.
 *
 * On dev-server start it applies database migrations, launches uvicorn (with auto-reload) on the API port,
 * waits until /health/ready answers, and stops the backend when the dev server stops. If a backend is already
 * answering on that port it is reused. Any failure stops `npm run dev` with the reason; nothing is faked.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Logger, Plugin } from 'vite'

const BACKEND_DIR = path.resolve(__dirname, '../backend')
const READY_TIMEOUT_MS = 45_000

async function ready(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

function pipe(stream: NodeJS.ReadableStream | null, log: Logger, recent: string[]) {
  stream?.setEncoding('utf8')
  stream?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      recent.push(line)
      if (recent.length > 30) recent.shift()
      log.info(`[backend] ${line}`, { timestamp: false })
    }
  })
}

export function backendDevServer({ port }: { port: number }): Plugin {
  let child: ChildProcess | null = null
  const stop = () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM') // the whole group: uvicorn's reloader and its worker
      } catch {
        /* already exited */
      }
    }
    child = null
  }

  return {
    name: 'ajanta-backend',
    apply: 'serve',
    async configureServer(server) {
      if (process.env.VITEST) return
      const log = server.config.logger
      if (await ready(port)) {
        log.info(`  ➜  Backend: already running on http://127.0.0.1:${port}, using it`)
        return
      }
      const bin = path.join(BACKEND_DIR, '.venv', 'bin')
      if (!existsSync(path.join(bin, 'uvicorn'))) {
        throw new Error(`Backend is not installed (${path.join(bin, 'uvicorn')} not found). Set it up once:\n`
          + '  cd backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt')
      }
      log.info('  ➜  Backend: applying database migrations…')
      const migrate = spawnSync(path.join(bin, 'alembic'), ['upgrade', 'head'], { cwd: BACKEND_DIR, encoding: 'utf8' })
      if (migrate.status !== 0) {
        throw new Error(`Database migration failed. Is PostgreSQL running and backend/.env correct?\n${(migrate.stderr || migrate.stdout).trim()}`)
      }

      const recent: string[] = []
      child = spawn(path.join(bin, 'uvicorn'), ['app.main:app', '--host', '127.0.0.1', '--port', String(port), '--reload'],
        { cwd: BACKEND_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      pipe(child.stdout, log, recent)
      pipe(child.stderr, log, recent)
      child.on('exit', (code, signal) => {
        if (child && signal === null && code !== 0) log.error(`[backend] stopped unexpectedly (exit code ${code}). Restart npm run dev.`)
        child = null
      })
      // Stop with the process, not with the dev server: Vite restarts its server in-process when .env or the
      // config changes, and the restarted server reuses this backend.
      process.once('exit', stop)
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => { stop(); process.exit(0) })

      const deadline = Date.now() + READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (!child) break
        if (await ready(port)) {
          log.info(`  ➜  Backend: http://127.0.0.1:${port} (API docs at /api/docs)`)
          return
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      stop()
      throw new Error(`Backend did not start on port ${port}.\n${recent.slice(-15).join('\n')}`)
    },
  }
}
