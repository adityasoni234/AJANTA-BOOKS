/**
 * Starts the Firebase Emulator Suite (Auth + Firestore) together with `npm run dev`, so local development never
 * touches the real project. Reuses emulators that are already running; stops the ones it started on exit.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Logger, Plugin } from 'vite'

const ROOT = path.resolve(__dirname, '..')
const READY_TIMEOUT_MS = 60_000
const JAVA_HOMES = ['/opt/homebrew/opt/openjdk@21', '/usr/local/opt/openjdk@21']

async function up(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

export function firebaseEmulators({ authPort = 9099, firestorePort = 8080, project }: { authPort?: number; firestorePort?: number; project: string }): Plugin {
  let child: ChildProcess | null = null
  const stop = () => {
    if (child?.pid && child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ }
    }
    child = null
  }
  return {
    name: 'ajanta-firebase-emulators',
    apply: 'serve',
    async configureServer(server) {
      if (process.env.VITEST) return
      const log: Logger = server.config.logger
      if ((await up(authPort)) && (await up(firestorePort))) {
        log.info('  ➜  Firebase emulators: already running, using them')
        return
      }
      const env = { ...process.env }
      const javaHome = JAVA_HOMES.find((p) => existsSync(path.join(p, 'bin', 'java')))
      if (javaHome) {
        env.JAVA_HOME = javaHome
        env.PATH = `${javaHome}/bin:${env.PATH}`
      }
      log.info('  ➜  Firebase emulators: starting Auth and Firestore…')
      child = spawn('firebase', ['emulators:start', '--only', 'auth,firestore', '--project', project], { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const recent: string[] = []
      for (const s of [child.stdout, child.stderr]) {
        s?.setEncoding('utf8')
        s?.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) if (line.trim()) { recent.push(line); if (recent.length > 30) recent.shift() }
        })
      }
      process.once('exit', stop)
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => { stop(); process.exit(0) })
      const deadline = Date.now() + READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (!child || child.exitCode !== null) break
        if ((await up(authPort)) && (await up(firestorePort))) {
          log.info(`  ➜  Firebase emulators: Auth :${authPort}, Firestore :${firestorePort} (local data only)`)
          return
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      stop()
      throw new Error(`Firebase emulators did not start. Needs Java 11+ and the Firebase CLI (npm i -g firebase-tools).\n${recent.slice(-15).join('\n')}`)
    },
  }
}
