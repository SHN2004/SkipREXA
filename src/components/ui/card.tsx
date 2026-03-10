import * as React from "react"
import { cn } from "@/lib/utils"

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ className, ...props }, ref) => (
        <div
            ref={ref}
            className={cn("rounded-xl border border-border bg-card-accent p-3.5 shadow-sm", className)}
            {...props}
        />
    )
)
Card.displayName = "Card"

export { Card }
