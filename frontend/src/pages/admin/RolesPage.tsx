import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/common/PageHeader'
import { LoadingRows } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/misc'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, titleCase } from '@/lib/utils'

interface Role { id: string; code: string; name: string; description: string | null; is_system: boolean; permissions: string[]; user_count: number }
interface Perm { code: string; module: string; description: string }

export default function RolesPage() {
  const { me } = useAuth()
  const qc = useQueryClient()
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') })
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Perm[]>('/permissions') })
  const [sel, setSel] = React.useState<string | 'new' | null>(null)
  const role = roles.data?.find((r) => r.id === sel)
  const [draft, setDraft] = React.useState<{ code: string; name: string; description: string; permissions: Set<string> }>({ code: '', name: '', description: '', permissions: new Set() })
  React.useEffect(() => {
    if (sel === 'new') setDraft({ code: '', name: '', description: '', permissions: new Set() })
    else if (role) setDraft({ code: role.code, name: role.name, description: role.description ?? '', permissions: new Set(role.permissions) })
  }, [sel, role])
  React.useEffect(() => { if (!sel && roles.data?.length) setSel(roles.data[0].id) }, [roles.data, sel])
  const mine = new Set(me?.permissions)
  const locked = role?.code === 'OWNER' || role?.code === me?.role_code
  const save = useMutation({
    mutationFn: () => {
      const body = { code: draft.code, name: draft.name, description: draft.description || null, permissions: [...draft.permissions] }
      return sel === 'new' ? api.post<Role>('/roles', body) : api.put<Role>(`/roles/${sel}`, body)
    },
    onSuccess: (r) => { toast.success('Role saved — permissions apply immediately'); void qc.invalidateQueries({ queryKey: ['roles'] }); setSel(r.id) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const del = useMutation({
    mutationFn: () => api.del(`/roles/${sel}`),
    onSuccess: () => { toast.success('Role deleted'); setSel(null); void qc.invalidateQueries({ queryKey: ['roles'] }) },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const modules = [...new Set((perms.data ?? []).map((p) => p.module))]
  return (
    <div>
      <PageHeader title="Roles & permissions" description="Permissions are enforced by the server on every request. Location scope is set per user." actions={<Button onClick={() => setSel('new')}><Plus /> New role</Button>} />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Card className="h-fit">
          {!roles.data ? <LoadingRows rows={6} cols={1} /> : (
            <ul className="p-2">
              {roles.data.map((r) => (
                <li key={r.id}>
                  <button onClick={() => setSel(r.id)} className={cn('w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2', sel === r.id && 'bg-primary-soft text-primary')}>
                    <span className="font-medium">{r.name}</span>
                    <span className="block text-xs text-muted">{r.user_count} users{r.is_system ? ' · system' : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {(role || sel === 'new') && (
          <Card>
            <CardHeader title={sel === 'new' ? 'New role' : role!.name} description={locked ? (role?.code === 'OWNER' ? 'The owner role always has every permission.' : 'You cannot edit your own role.') : 'You can only grant permissions you hold yourself.'}
              actions={<>
                {role && !role.is_system && role.user_count === 0 && <Button variant="danger-outline" size="sm" loading={del.isPending} onClick={() => del.mutate()}>Delete</Button>}
                {!locked && <Button size="sm" loading={save.isPending} disabled={!draft.name || !draft.code} onClick={() => save.mutate()}>Save role</Button>}
              </>} />
            <CardBody className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Code"><Input value={draft.code} disabled={!!role?.is_system || locked} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} /></Field>
                <Field label="Name"><Input value={draft.name} disabled={locked} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                <Field label="Description"><Input value={draft.description} disabled={locked} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {modules.map((m) => (
                  <fieldset key={m} className="rounded-md border border-border p-3">
                    <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">{titleCase(m)}</legend>
                    <div className="space-y-1.5">
                      {perms.data!.filter((p) => p.module === m).map((p) => (
                        <label key={p.code} className={cn('flex items-start gap-2 text-sm', !mine.has(p.code) && 'opacity-50')}>
                          <Checkbox className="mt-0.5" checked={draft.permissions.has(p.code)} disabled={locked || !mine.has(p.code)}
                            onCheckedChange={(v) => setDraft((d) => { const s = new Set(d.permissions); if (v) s.add(p.code); else s.delete(p.code); return { ...d, permissions: s } })} />
                          <span>{p.description} <Badge className="ml-1">{p.code}</Badge></span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  )
}
