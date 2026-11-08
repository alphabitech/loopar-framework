import { MoonIcon, SunIcon } from "@radix-ui/react-icons"

import { Button } from "@cn/components/ui/button"
import { useWorkspace } from "@workspace/workspace-provider"
import { __ } from "@global/i18n";

export function ThemeToggle() {
  const { theme, setTheme } = useWorkspace();

  const toggle = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  return (
    <Button
      variant="outline"
      size="icon"
      className="hover:text-primary"
      onClick={toggle}
      aria-label={__("Toggle theme")}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    >
      <SunIcon className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <MoonIcon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">{__("Toggle theme")}</span>
    </Button>
  )
}
