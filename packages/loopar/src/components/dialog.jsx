import React, { useRef, useId , useEffect, useState} from "react";
import loopar from "loopar";
import {Button} from "@cn/components/ui/button";
import { AlertCircle, InfoIcon, HelpCircle } from "lucide-react";
import { cn } from "@cn/lib/utils"
import { SlideButton } from "./button";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@cn/components/ui/dialog"

import { Label } from "@cn/components/ui/label";
import { Textarea } from "@cn/components/ui/textarea";
import { __ } from "@global/i18n";

export { SlideButton };

const DialogContext = React.createContext();
const DialogContextProvider = ({children}) => {
  return (
    <DialogContext.Provider value={{
      inDialog: true
    }}>
      {children}
    </DialogContext.Provider>
  )
}

export const useDialogContext = () => {
  return React.useContext(DialogContext) || {
    inDialog: false
  }
}

const Icon = ({type, size, ...props}) => {
  const icons = {
    alert: [AlertCircle, "text-red-500"],
    info: [InfoIcon, "text-blue-500"],
    confirm: [HelpCircle, "text-yellow-500"],
    error: [AlertCircle, "text-red-500"],
  }

  const icon = icons[type] || icons.info;
  const [Icon, color] = icon

  return <Icon size={size || 24} className={cn(color, props.className)} />;
}

// Lazy: a static import would close the cycle @dialog -> entry-modal -> modal-workspace -> @dialog
const EntryModal = React.lazy(() =>
  import("@app/entry-modal").then((m) => ({ default: m.EntryModal }))
);

const MetaDialog = (props) => {
  const [open, setOpen] = useState(props.open || false);
  const [entryPath, setEntryPath] = useState(null);

  useEffect(() => {
    setOpen(props.open)
  }, [props.open])

  const handleSetOpenClose = (open) => {
    loopar.handleOpenCloseDialog(props.id, open);
    if(open) props.onOpen && props.onOpen();
    if(!open) props.onClose && props.onClose();
  };

  const setDialogOpen = (open, validate=true) => {
    if(!open && validate && props.validate && !props.validate(props.value)) return;
    handleSetOpenClose(open);
  };

  const okButton = useRef(null);

  const sizes = {
    sm: "md:min-w-[45%] lg:min-w-[40%] xl:min-w-[35%]",
    md: "md:min-w-[60%] lg:min-w-[50%] xl:min-w-[45%]",
    lg: "md:min-w-[75%] lg:min-w-[70%] xl:min-w-[60%]",
    full: "min-w-[100%] min-h-[100%] max-w-[100%] max-h-[100%]",
  };

  const content = props.children || props.content || props.message;
  const contentType = typeof content === "string" ? "text" : "react";

  /**
   * String content: split multi-message strings into one line each.
   * Sources join errors with '\n' (client validate()) or '<br/>' (server
   * core-document / submitForm); rendered inside a single <p> both collapsed
   * into one run-on paragraph. Multiple lines render as a disc list; a single
   * line keeps the plain paragraph. Inline HTML per line (e.g. the <a> links
   * of the delete-connected message) still works as before.
   */
  // Internal <a> inside raw-HTML content opens in an EntryModal (like Link
  // inModal) instead of navigating away; modified clicks keep the native <a>.
  const handleContentClick = (e) => {
    const anchor = e.target.closest?.("a");
    if (!anchor || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const href = anchor.getAttribute("href") || "";
    if (!href.startsWith("/") || anchor.target === "_blank") return;

    e.preventDefault();
    setEntryPath(href);
  };

  const renderTextContent = (raw) => {
    const lines = String(raw)
      .split(/\n|<br\s*\/?>/gi)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length <= 1) {
      return (
        <div
          className="h-full"
          onClick={handleContentClick}
          dangerouslySetInnerHTML={{ __html: `<p>${lines[0] || ""}</p>` }}
        />
      );
    }

    return (
      <div
        className="h-full"
        onClick={handleContentClick}
        dangerouslySetInnerHTML={{
          __html: `<ul class="list-disc pl-5 space-y-1 text-left">${lines
            .map((line) => `<li>${line}</li>`)
            .join("")}</ul>`,
        }}
      />
    );
  };

  const getButtons = () => {
    if(Array.isArray(props.buttons) && props.buttons.length === 0) return [];

    const buttons = props.buttons || [];
    if (buttons.length === 0) {
      buttons.push({
        name: "ok",
        text: "OK",
        variant: "secondary",
        onClick: () => {
          props.ok && props.ok(props.value);
          setDialogOpen(false);
        },
        dismiss: true,
      });

      props.type === "confirm" &&
        buttons.push({
          name: "cancel",
          text: "Cancel",
          variant: "secondary",
          onClick: () => {
            props.cancel && props.cancel();
            setDialogOpen(false);
          },
          dismiss: true,
        });
    } else {
      const okButton = buttons.find((b) => b.name === "ok");

      if (okButton) {
        const okFunc = okButton.onClick;
        okButton.onClick = () => {
          okFunc && okFunc();
          props.ok && props.ok();
          setDialogOpen(false);
        };
      }

      const cancelButton = buttons.find((b) => b.name === "cancel");

      if (cancelButton) {
        const cancelFunc = cancelButton.onClick;
        cancelButton.onClick = () => {
          cancelFunc && cancelFunc();
          props.cancel && props.cancel();
          setDialogOpen(false, false);
        };
      }
    }

    return buttons;
  }

  return (
    <DialogContextProvider>
      <Dialog open={open} onOpenChange={handleSetOpenClose} key={props.id}>
        <DialogContent className={`sm:max-w-md ${sizes[props.size || "sm"]} flex flex-col`}>
          <DialogHeader>
            <DialogTitle className="flex space-x-2">
              {props.icon ? props.icon : (props.type && <Icon type={props.type} size={36} className=" opacity-50"/>)}
              <h2 className="text-2xl">{props.title}</h2>
            </DialogTitle>
          </DialogHeader>
          <DialogDescription className={`overflow-auto max-h-[80vh] ${props.size == 'full' && 'h-[100vh]'}`}>
            <>
            {
              contentType === "text" ? (
                renderTextContent(content)
              ) : (
                <div className="h-full">{content}</div>
              )
            }
            <div className="fixed bottom-5 right-5 z-0 opacity-5" style={{zIndex:"-1"}}><Icon type={props.type} size={130}/></div>
            </>
          </DialogDescription>
          {props.hasFooter !== false && (
            <DialogFooter>
              {(getButtons() || []).map((b) => {
                if (props.slide && b.name === "ok") {
                  return (
                    <SlideButton
                      key={b.name}
                      text={__(props.slideText || b.text || "Slide to confirm")}
                      confirmedText={props.slideConfirmedText || "Confirmed"}
                      threshold={typeof props.slideThreshold === "number" ? props.slideThreshold : 0.95}
                      onConfirm={() => {
                        b.dismiss && setDialogOpen(false);
                        b.onClick();
                      }}
                    />
                  );
                }

                return (
                  <Button
                    key={b.name}
                    variant={b.variant || "primary"}
                    onClick={(e) => {
                      e.preventDefault();

                      b.dismiss && setDialogOpen(false);
                      b.onClick();
                    }}
                    ref={b.name === "ok" ? okButton : null}
                  >
                    {b.content || __(b.text || b.label)}
                  </Button>
                );
              })}
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
      {entryPath && (
        <React.Suspense fallback={null}>
          <EntryModal initialPath={entryPath} onClose={() => setEntryPath(null)} />
        </React.Suspense>
      )}
    </DialogContextProvider>
  );
};

export default MetaDialog;

export function Prompt (props) {
  const id = useId();
  const [value, setValue] = useState(props.initialValue || "");

  const handleChange = (e) => {
    setValue(e.target.value);
  }

  const getRows = () => {
    return {"sm": 5, "md": 10, "lg": 15, "full": 20}[props.size || "md"]
  }

  return (
    <MetaDialog
      {...props}
      value={value}
      type="prompt"
      ok={() => props.ok(value)}
      size={props.size || "md"}
    >
      <div className="grid w-full items-center gap-1.5">
        <Label htmlFor="form-control">{props.label || ""}</Label>
        <Textarea 
          type="text"
          id={`prompt-input-${id}`}
          placeholder={props.placeholder || ""}
          className="border border-input rounded-xm bg-transparent p-2 mt-2"
          onChange={handleChange}
          rows={getRows()}
          value={value}
        />
      </div>
    </MetaDialog>
  )
}

export function Confirm (props) {
  return (
    <MetaDialog
      {...props}
      type="confirm"
    >
      {props.children}
    </MetaDialog>
  )
}

export function Alert (props) {
  return (
    <MetaDialog
      {...props}
      type="alert"
    >
      {props.children}
    </MetaDialog>
  )
}

export const Modal = (props) => {
  return <MetaDialog {...props} >{props.children}</MetaDialog>;
};