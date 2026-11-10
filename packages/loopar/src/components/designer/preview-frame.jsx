import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Monitor, Tablet, Smartphone, EyeIcon, XIcon } from "lucide-react";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";

// Device widths for the preview frame. `null` = the full canvas width.
export const PREVIEW_DEVICES = [
  { name: "desktop", label: "Desktop", width: null, Icon: Monitor },
  { name: "tablet", label: "Tablet", width: 768, Icon: Tablet },
  { name: "mobile", label: "Mobile", width: 390, Icon: Smartphone },
];

// Standards-mode empty document (a src-less iframe is about:blank = quirks).
const FRAME_DOC = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><div id=\"lp-preview-root\"></div></body></html>";

const MARK = "data-lp-preview-style";

// What stays live in the preview: view state that never leaves the page
// (tabs, disclosures, toggles, typing). Everything else that would act —
// navigate, submit, save, open portaled popovers (they would render in the
// host document) — is swallowed before React sees it. Hover and focus are
// untouched, so the visual states remain.
const LIVE = [
  '[role="tab"]', '[role="checkbox"]', '[role="switch"]', '[role="radio"]',
  'input:not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"])',
  "textarea", "label", "summary", "[contenteditable]",
  '[aria-controls][aria-expanded]:not([aria-haspopup])',
].join(",");
const ACTIONABLE = [
  "a[href]", "button", '[role="button"]', '[role="combobox"]', "[aria-haspopup]",
  'input[type="submit"]', 'input[type="button"]', 'input[type="image"]', 'input[type="reset"]',
].join(",");

// `root`: the preview frame's document, or the element holding the inline
// preview. Capture listeners on it run before React's handlers (registered
// higher up, at the app root, for the inline case they fire on the way back
// up) — stopping propagation there keeps them from firing. Returns a cleanup.
export const guardInteractions = (root) => {
  if (!root) return () => {};
  const blocked = (target) => {
    const el = target?.closest ? target : target?.parentElement;
    if (!el || el.closest(LIVE)) return false;
    return !!el.closest(ACTIONABLE);
  };

  // Pointer/mouse down: stop React (Radix opens on pointerdown) but keep the
  // default so the element still takes focus.
  const stopOnly = (e) => blocked(e.target) && e.stopPropagation();
  const stopAndPrevent = (e) => {
    if (!blocked(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onKey = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target;
    // Enter in a single-line input would submit its form.
    const submitsForm = e.key === "Enter" && el?.tagName === "INPUT" && el.form;
    if (submitsForm || blocked(el)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onSubmit = (e) => { e.preventDefault(); e.stopPropagation(); };
  const listeners = [
    ...["pointerdown", "mousedown", "touchstart"].map(t => [t, stopOnly]),
    ...["click", "auxclick", "dblclick", "pointerup", "mouseup"].map(t => [t, stopAndPrevent]),
    ["submit", onSubmit],
    ["keydown", onKey],
  ];
  listeners.forEach(([t, fn]) => root.addEventListener(t, fn, true));
  return () => listeners.forEach(([t, fn]) => root.removeEventListener(t, fn, true));
};

// Mirrors the host page's stylesheets and theme onto the frame, so the frame
// renders with the same Tailwind build, fonts, theme variables and dark mode.
const syncFrame = (doc) => {
  if (!doc?.head) return;
  doc.head.querySelectorAll(`[${MARK}]`).forEach(n => n.remove());
  document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(node => {
    const copy = node.cloneNode(true);
    if (copy.tagName === "LINK") copy.href = node.href;
    copy.setAttribute(MARK, "");
    doc.head.appendChild(copy);
  });

  const src = document.documentElement, dst = doc.documentElement;
  dst.className = src.className;
  for (const attr of ["style", "data-theme", "lang", "dir"]) {
    const v = src.getAttribute(attr);
    v == null ? dst.removeAttribute(attr) : dst.setAttribute(attr, v);
  }
  doc.body.className = document.body.className;
};

/**
 * Renders `children` inside an iframe (React portal, so contexts carry over).
 * The frame has its own viewport: media queries (`md:`, `lg:`), `vh` units and
 * fixed positioning resolve against the frame, not the browser window — what
 * a visitor on that device width would get.
 */
export function PreviewFrame({ width, frameRef, onWidth, onEscape, children }) {
  const iframeRef = useRef(null);
  const [mount, setMount] = useState(null);

  const setRefs = (el) => {
    iframeRef.current = el;
    if (frameRef) frameRef.current = el;
  };

  const handleLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    syncFrame(doc);
    guardInteractions(doc);
    // Keys typed inside the frame never reach the host window.
    onEscape && doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape") onEscape();
    });
    setMount(doc.getElementById("lp-preview-root"));
  };

  // Keep styles/theme in step with the host (HMR style updates, theme toggle).
  useEffect(() => {
    if (!mount) return;
    let frame = null;
    const resync = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        syncFrame(iframeRef.current?.contentDocument);
      });
    };
    const observer = new MutationObserver(resync);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      frame && cancelAnimationFrame(frame);
    };
  }, [mount]);

  // Report the actual frame width (desktop = whatever the canvas allows).
  useEffect(() => {
    const el = iframeRef.current;
    if (!el || !onWidth) return;
    const ro = new ResizeObserver(() => onWidth(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onWidth]);

  return (
    <>
      <iframe
        ref={setRefs}
        title={__("Preview")}
        srcDoc={FRAME_DOC}
        onLoad={handleLoad}
        className="mx-auto block border-0 bg-background transition-[width] duration-200"
        // Fills its box and scrolls inside, like a device viewport. Sizing it
        // to its content would make `vh` sections (min-h-screen heroes) grow
        // with the frame forever.
        style={{ width: width ? `${width}px` : "100%", maxWidth: "100%", height: "100%" }}
      />
      {mount && createPortal(children, mount)}
    </>
  );
}

export function DeviceSelector({ device, onChange, frameWidth }) {
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <div role="tablist" className="flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
        {PREVIEW_DEVICES.map(({ name, label, Icon }) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={device === name}
            title={__(label)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2 py-1 font-medium transition-colors",
              device === name ? "bg-background text-foreground shadow-sm" : "hover:text-foreground"
            )}
            onClick={() => onChange(name)}
          >
            <Icon className="h-3.5 w-3.5"/>
            <span>{__(label)}</span>
          </button>
        ))}
      </div>
      {frameWidth ? <span className="tabular-nums">{frameWidth}px</span> : null}
    </div>
  );
}

/**
 * Full-screen preview. The page renders in its own frame (its own viewport),
 * so it is shown as its own window over the designer, which stays mounted
 * underneath untouched.
 */
export function PreviewModal({ open, title, onClose, frameRef, children }) {
  const [device, setDevice] = useState("desktop");
  const [frameWidth, setFrameWidth] = useState(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={__("Preview")}
      className="fixed inset-0 z-[100] flex flex-col bg-background dark:bg-background-dark"
    >
      <div className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <EyeIcon className="h-4 w-4 shrink-0 text-muted-foreground"/>
          <span className="font-medium">{__("Preview")}</span>
          {title && <span className="truncate text-muted-foreground">{title}</span>}
        </div>
        <DeviceSelector device={device} onChange={setDevice} frameWidth={frameWidth}/>
        <div className="flex items-center justify-end gap-3">
          <span className="hidden text-xs text-muted-foreground lg:inline" title={__("Tabs, toggles and inputs stay interactive; links and actions do nothing here.")}>
            {__("Links and actions are disabled")}
          </span>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            title={__("Close preview (Esc)")}
            onClick={onClose}
          >
            <kbd className="rounded border border-border px-1 text-[10px] leading-4">Esc</kbd>
            <XIcon className="h-4 w-4"/>
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-muted/30">
        <PreviewFrame
          frameRef={frameRef}
          onWidth={setFrameWidth}
          onEscape={onClose}
          width={PREVIEW_DEVICES.find(d => d.name === device)?.width}
        >
          {children}
        </PreviewFrame>
      </div>
    </div>,
    document.body
  );
}
