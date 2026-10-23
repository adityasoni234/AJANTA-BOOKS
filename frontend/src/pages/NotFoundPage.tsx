import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/States'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  return (
    <EmptyState
      title="Page not found"
      description="The page you’re looking for doesn’t exist or you don’t have access to it."
      action={<Button asChild variant="secondary"><Link to="/">Go to home</Link></Button>}
    />
  )
}
