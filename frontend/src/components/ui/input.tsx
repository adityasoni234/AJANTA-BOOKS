import * as LabelPrimitive from '@radix-ui/react-label'
import * as React from 'react'
import { cn } from '@/lib/utils'

const field =
  'flex w-full rounded-md border border-border bg-white px-3 text-sm shadow-xs transition-colors placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary/60 focus-visible:border-primary disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted aria-[invalid=true]:border-danger'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input ref={ref} type={type} className={cn(field, 'h-9', type === 'number' && 'num', className)} {...props} />
  ),
)
Input.displayName = 'Input'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(field, 'min-h-20 py-2', className)} {...props} />,
)
Textarea.displayName = 'Textarea'

export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        field,
        'h-9 appearance-none bg-[url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%2716%27 height=%2716%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%2364748b%27 stroke-width=%272%27><path d=%27m6 9 6 6 6-6%27/></svg>")] bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat pr-8',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
)
NativeSelect.displayName = 'NativeSelect'

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn('text-xs font-medium text-slate-700', className)} {...props} />
))
Label.displayName = 'Label'

interface FieldProps {
  label: string
  htmlFor?: string
  error?: string
  hint?: string
  required?: boolean
  className?: string
  children: React.ReactNode
}

export function Field({ label, htmlFor, error, hint, required, className, children }: FieldProps) {
  // Associate the label with its control even when no explicit id is given.
  const autoId = React.useId()
  const id = htmlFor ?? autoId
  const msgId = `${id}-msg`
  const control = React.isValidElement<{ id?: string; 'aria-describedby'?: string }>(children) && !htmlFor
    ? React.cloneElement(children, { id: children.props.id ?? id, 'aria-describedby': error || hint ? msgId : undefined })
    : children
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
      </Label>
      {control}
      {error ? (
        <p id={msgId} className="text-xs text-danger" role="alert">{error}</p>
      ) : hint ? (
        <p id={msgId} className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  )
}
