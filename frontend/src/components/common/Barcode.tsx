import JsBarcode from 'jsbarcode'
import * as React from 'react'

export function Barcode({ value, format = 'CODE128', height = 40, width = 1.4, fontSize = 11, displayValue = true }: {
  value: string
  format?: 'CODE128' | 'EAN13'
  height?: number
  width?: number
  fontSize?: number
  displayValue?: boolean
}) {
  const ref = React.useRef<SVGSVGElement>(null)
  React.useEffect(() => {
    if (!ref.current) return
    try {
      JsBarcode(ref.current, value, { format, height, width, fontSize, displayValue, margin: 0, background: 'transparent' })
    } catch {
      JsBarcode(ref.current, value, { format: 'CODE128', height, width, fontSize, displayValue, margin: 0 })
    }
  }, [value, format, height, width, fontSize, displayValue])
  return <svg ref={ref} role="img" aria-label={`Barcode ${value}`} />
}
