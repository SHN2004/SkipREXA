import { Moon, Sun } from "lucide-react"
import { useTheme } from "@/components/theme-provider"

export function ThemeToggle() {
    const { theme, setTheme } = useTheme()

    const isDark = theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark-theme"));

    return (
        <button
            onClick={() => setTheme(isDark ? "light" : "dark")}
            className="relative w-[60px] h-[28px] bg-border rounded-full flex shrink-0 shadow-inner transition-colors hover:bg-border/80"
        >
            <div className="absolute inset-0 flex justify-between items-center px-[7px] pointer-events-none">
                <Sun className={`w-3.5 h-3.5 transition-all ${!isDark ? 'text-white scale-110 opacity-100' : 'text-muted-foreground opacity-50'}`} />
                <Moon className={`w-3.5 h-3.5 transition-all ${isDark ? 'text-white scale-110 opacity-100' : 'text-muted-foreground opacity-50'}`} />
            </div>
            <div className={`absolute top-[3px] left-[3px] w-[22px] h-[22px] rounded-full shadow-md transition-all duration-300 ease-out z-10 ${isDark ? 'translate-x-[32px] bg-gradient-to-br from-[#4A4A4A] to-[#3A3A3A]' : 'bg-gradient-to-br from-white to-[#f5f5f5]'
                }`} />
        </button>
    )
}
