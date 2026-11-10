import { useState, useEffect, useRef } from "react";
import BaseInput from "@base-input";
import {
  FormControl,
  FormDescription,
  FormLabel,
} from "@cn/components/ui/form";
import { Textarea } from "@cn/components/ui/textarea";
import { AlertTriangle, Loader2 } from "lucide-react";
import loopar from "loopar"
import { __ } from "@global/i18n";

const TAILWIND_CDN = "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4";

export default function Tailwind(props) {
  const { renderInput, data } = BaseInput(props);
  const [scriptStatus, setScriptStatus] = useState("idle");
  const loadAttempted = useRef(false);

  useEffect(() => {
    if (loadAttempted.current) return;
    loadAttempted.current = true;

    const isDev = import.meta.env?.DEV;
    if (!isDev) {
      setScriptStatus("loaded");
      return;
    }

    const existingScript = document.querySelector(`script[src="${TAILWIND_CDN}"]`);
    if (existingScript) {
      setScriptStatus("loaded");
      return;
    }

    setScriptStatus("loading");

    const configStyle = document.createElement('style');
    configStyle.setAttribute('type', 'text/tailwindcss');
    configStyle.textContent = `
      @layer theme, base, components, utilities;
      @import "tailwindcss/theme.css" layer(theme);
      @import "tailwindcss/utilities.css" layer(utilities);
    `;
    document.head.appendChild(configStyle);

    loopar.scriptManager.loadScript(
      TAILWIND_CDN,
      null,
      { 
        async: true, 
        addExtension: false,
        position: "after",
        target: "script[src*='@vite/client']"
      }
    )
      .then(() => setScriptStatus("loaded"))
      .catch(() => setScriptStatus("error"));
  }, []);

  const isLoading = scriptStatus === "loading";
  const hasError = scriptStatus === "error";
  const isReady = scriptStatus === "loaded";


  return renderInput(({ isInvalid, ...inputProps }) => (
    <div>
      <FormLabel>{data.label}</FormLabel>
      <div className="relative">
        <FormControl className="p-2">
          <Textarea
            {...inputProps}
            placeholder={data.placeholder || data.label}
            className="bg-transparent border border-input rounded-xm disabled:opacity-50 w-full"
            rows={6}
            disabled={!isReady}
          />
        </FormControl>
        
        {isLoading && (
          <div className="absolute inset-0 bg-background/80 flex items-center justify-center rounded-xm pointer-events-none">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">{__("Loading Tailwind...")}</span>
          </div>
        )}
      </div>

      {hasError && (
        <p className="text-xs text-destructive flex items-center gap-1 mt-1">
          <AlertTriangle className="h-3 w-3" />
          {__("Failed to load Tailwind. You can still type classes manually.")}
        </p>
      )}

      <FormDescription className="flex flex-col border border-input rounded-xm p-2 bg-muted mt-2">
        <span>{__("Powered by")} <a className="text-blue-600 visited:text-purple-600" href="https://tailwindcss.com/docs/installation/using-vite" target="_blank" rel="noreferrer">{__("Tailwind")}</a></span>
        <span className="text-muted-foreground text-xs">
          {__("Use Tailwind classes like")} <code className="bg-muted px-1 rounded">bg-red-500</code>{__(". Custom classes require your own CSS file.")}
        </span>
        <span className="text-xs text-amber-500 flex items-center gap-1 mt-1">
          <AlertTriangle className="h-3 w-3" />
          {__("Classes preview only works in development mode")}
        </span>
      </FormDescription>
    </div>
  ));
}

Tailwind.metaFields = () => BaseInput.metaFields();
