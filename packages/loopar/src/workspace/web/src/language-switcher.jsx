import { buttonVariants } from "@cn/components/ui/button";
import { cn } from "@cn/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cn/components/ui/dropdown-menu";
import { CheckIcon, GlobeIcon } from "lucide-react";
import { useWorkspace } from "@workspace/workspace-provider";
import { __, currentLanguage, languageName, localizePath } from "@global/i18n";

/**
 * Website language menu (globe button in the header). Each option is the
 * same page under the other language's URL, as a real link: the page's
 * dictionary loads before hydration, so changing language is a full load.
 * Hidden on sites that publish a single language.
 */
export function LanguageSwitcher({ className }) {
  const { __META__ } = useWorkspace();
  const site = __META__?.site_languages;
  if (!site || (site.languages || []).length < 2) return null;

  const active = currentLanguage();
  const alternates = new Map((site.alternates || []).map((a) => [a.language, a.href]));
  const hrefOf = (code) => {
    if (typeof window === "undefined") return alternates.get(code) || "/";
    const { pathname, search, hash } = window.location;
    return localizePath(pathname, code, site) + search + hash;
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1 px-2", className)}
        aria-label={__("Language")}
      >
        <GlobeIcon className="h-4 w-4" />
        <span className="text-xs font-semibold uppercase">{active.split("-")[0]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {site.languages.map((code) => (
          <DropdownMenuItem key={code} asChild>
            <a href={hrefOf(code)} hrefLang={code} lang={code} className="flex items-center justify-between gap-6">
              {languageName(code)}
              {code === active && <CheckIcon className="h-4 w-4" />}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
