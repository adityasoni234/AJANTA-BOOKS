// Renders firestore.rules from firestore.rules.template, filling in how many businesses may register
// (MAX_BUSINESSES in the environment or frontend/.env.local, default 2; keep it equal to MAX_BUSINESSES in
// frontend/src/server/admin.ts). The generated file is gitignored.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let max = process.env.MAX_BUSINESSES
const envFile = join(root, 'frontend', '.env.local')
if (!max && existsSync(envFile)) max = readFileSync(envFile, 'utf8').match(/^MAX_BUSINESSES=(.+)$/m)?.[1]?.trim()
max = max || '2'
if (!/^[1-9]\d{0,3}$/.test(max)) {
  console.error('MAX_BUSINESSES must be a positive whole number')
  process.exit(1)
}
const rules = readFileSync(join(root, 'firestore.rules.template'), 'utf8').replaceAll('__MAX_BUSINESSES__', max)
writeFileSync(join(root, 'firestore.rules'), rules)
console.log(`firestore.rules written (up to ${max} businesses)`)
