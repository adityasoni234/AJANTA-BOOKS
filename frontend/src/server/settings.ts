/** Organisation policy and identity, read from live reference collections. */
import { DEFAULT_POLICY, type Policy } from './permissions'
import { all, type Row } from './store'

export async function getPolicy(): Promise<Policy> {
  const row = (await all('settings')).find((s) => s.id === 'policy')
  return { ...DEFAULT_POLICY, ...((row?.value as Partial<Policy>) ?? {}) }
}
export async function getOrg(): Promise<Row | null> {
  return (await all('organization'))[0] ?? null
}
