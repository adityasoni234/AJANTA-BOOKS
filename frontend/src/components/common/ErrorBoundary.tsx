import { AlertTriangle } from 'lucide-react'
import * as React from 'react'
import { Button } from '@/components/ui/button'

interface State { error: Error | null }

/** Keeps the shell usable if a page throws while rendering. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Page render error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" className="mx-auto mt-16 max-w-md rounded-lg border border-red-200 bg-white p-6 text-center shadow-[var(--shadow-card)]">
        <AlertTriangle className="mx-auto mb-3 size-6 text-danger" />
        <p className="font-medium">This page hit an unexpected error</p>
        <p className="mt-1 text-sm text-muted">Your data is safe. Reload the page, and contact support if it keeps happening.</p>
        <Button className="mt-4" variant="secondary" onClick={() => window.location.reload()}>Reload</Button>
      </div>
    )
  }
}
