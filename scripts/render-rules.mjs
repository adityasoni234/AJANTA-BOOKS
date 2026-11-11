// Renders firestore.rules from firestore.rules.template, filling in the owner email allowed to run first-time
// setup (SETUP_EMAIL in frontend/.env.local or the environment). The generated file is gitignored.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let email = process.env.SETUP_EMAIL
const envFile = join(root, 'frontend', '.env.local')
if (!email && existsSync(envFile)) {
  email = readFileSync(envFile, 'utf8').match(/^SETUP_EMAIL=(.+)$/m)?.[1]?.trim()
}
if (!email || !/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email)) {
  console.error('SETUP_EMAIL is missing or invalid. Add SETUP_EMAIL=<owner email> to frontend/.env.local')
  process.exit(1)
}
const rules = readFileSync(join(root, 'firestore.rules.template'), 'utf8').replaceAll('__SETUP_EMAIL__', email.toLowerCase())
writeFileSync(join(root, 'firestore.rules'), rules)
console.log(`firestore.rules written (setup allowed for ${email.replace(/^(.).*(@.*)$/, '$1***$2')})`)
