import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputProps
    extends React.InputHTMLAttributes<HTMLInputElement> { }

const Input = React.forwardRef<HTMLInputElement, InputProps>(
    ({ className, type, ...props }, ref) => {
        return (
            <input
                type={type}
                className={cn(
                    "flex w-full rounded-none border-2 border-input bg-card px-4 py-3.5 text-sm font-main shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] dark:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.6)] transition-all placeholder:text-muted-foreground/80 focus-visible:outline-none focus:border-primary focus:shadow-[4px_4px_0px_0px_var(--ring)] dark:focus:shadow-[4px_4px_0px_0px_var(--ring)] focus:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50",
                    className
                )}
                ref={ref}
                {...props}
            />
        )
    }
)
Input.displayName = "Input"

export { Input }
