import { __ } from "@global/i18n";
export const MetaLoadError = ({ element, error }) => {
  const isDev = process.env.NODE_ENV !== "production";
  const detail = isDev && error?.message ? String(error.message) : null;

  return (
    <div className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-left">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" />
        <span className="font-mono text-xs tracking-wide text-destructive">
          {__("COMPONENT FAILED")}{element ? ` · ${element}` : ""}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {__("The component")}{" "}
        {element ? (
          <code className="font-mono text-foreground">{element}</code>
        ) : (
          "requested here"
        )}{" "}
        {__("could not be loaded.")}
      </p>
      {detail ? (
        <pre
          className="mt-2 overflow-auto rounded-md border border-destructive/20 bg-muted/40 p-2 font-mono text-xs leading-relaxed text-muted-foreground"
          style={{ whiteSpace: "pre-wrap", maxHeight: "30vh" }}
        >
          {detail}
        </pre>
      ) : null}
    </div>
  );
};
