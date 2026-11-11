import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App'
import { TooltipProvider } from './components/ui/misc'
import { ApiError } from './lib/api'
import { AuthProvider } from './lib/auth'
import './lib/firebase'
import './index.css'

// Data is always live: every screen reloads when opened and when the window regains focus, and any
// successful change (sale, receipt, transfer, import…) refreshes all data on screen, since one action
// affects stock, sets, balances and reports elsewhere.
const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
  mutationCache: new MutationCache({
    onSuccess: () => { void queryClient.invalidateQueries() },
  }),
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <TooltipProvider>
            <App />
            <Toaster position="top-right" richColors closeButton />
          </TooltipProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
