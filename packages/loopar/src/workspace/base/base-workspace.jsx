import { useState, useEffect, useRef } from "react";
import BaseDialog, {Prompt} from "@dialog";
import { toast } from "sonner";
import { Toaster } from "@sonner";
import { useWorkspace, WorkspaceProviderContext } from "@workspace/workspace-provider";
import loopar from "loopar";
import Emitter from '@services/emitter/emitter';
import { Loader2Icon } from "lucide-react";

const Notify = () => {
  const { theme } = useWorkspace();
  return <Toaster richColors theme={theme} />;
}

const Loading = () => {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const handleLoading = (freeze) => {
      setLoading(freeze);
    };

    Emitter.on('freeze', handleLoading);
    return () => {
      Emitter.off('freeze', handleLoading);
    };
  }, []);

  return loading ? (
    <div 
      style={{ zIndex: 1000 }}
      className="fixed backdrop-blur-sm top-0 left-0 w-full h-full transition-all ease-in-out duration-600"
    >
      <div className="flex justify-center items-center w-full h-full">
        <Loader2Icon className="text-slate-500 w-10 h-10 animate-spin" />
      </div>
    </div>
  ) : null;
};

export function DialogContextProvider() {
  const [dialogs, setDialogs] = useState({});
  const dialogsRef = useRef({});
  const { theme } = useWorkspace();

  const handleSetDialogs = (dialogs) => {
    setDialogs(dialogs);
  }

  const setDialog = (dialog) => {
    dialogsRef.current[dialog.id] = dialog;
    handleSetDialogs({ ...dialogsRef.current });
  }

  const setNotify = ({ title, message, type = "info", timeout = 5000 }) => {
    const description = typeof message === "string"
      ? <span dangerouslySetInnerHTML={{ __html: message }} />
      : message;

    (toast[type] || toast)(title || loopar.utils.Capitalize(type), {
      description,
      duration: timeout,
      theme: theme
    });
  }

  const Dialog = (_dialog) => {
    const dialog = { ..._dialog };
    dialog.id ??= typeof dialog.message === "string" ? dialog.message : dialog.title;
    dialog.open = dialog.open !== false;

    setDialog(dialog);
  }

  const setDialogOpen = (id, open) => {
    const current = dialogsRef.current[id];
    current && (current.open = open);

    handleSetDialogs({ ...dialogsRef.current });
  }

  useEffect(() => {
    const handleNotify = (message) => {
      setNotify(message);
    };

    const handleDialog = (dialog) => {
      Dialog(dialog);
    };

    Emitter.on('notify', handleNotify);
    Emitter.on('dialog', handleDialog);
    Emitter.on('handle-open-close-dialog', setDialogOpen);
    
    return () => {
      Emitter.off('notify', handleNotify);
      Emitter.off('dialog', handleDialog);
      Emitter.off('handle-open-close-dialog', setDialogOpen);

      window.removeEventListener("error", event => {
        console.error("LOOPAR: uncaughtException", event.message, event.error);
      });
    }
  }, []);

  return (
    <>
      {Object.values(dialogs).filter(d => d.open).map((dialog, index) => {
        return dialog.type === "prompt" ? (
          <Prompt {...dialog} open={dialog.open} size={dialog.size || "sm"}/>
        ) : (
          <BaseDialog {...dialog} key={dialog.id} open={dialog.open} />
        );
      })}
      <Notify />
    </>
  );
}

export default function BaseWorkspace(props) {
  const workspace = useWorkspace();
  // The listener is registered once: read the latest refresh through a ref.
  // Calling the first render's `workspace.refresh` refetched the initial
  // pathname, which lacks the query (`update` without `?name=`) → a new doc.
  const refreshRef = useRef(workspace.refresh);
  refreshRef.current = workspace.refresh;

  useEffect(() => {
    // Accepts an optional payload. loopar.reload() invokes it with
    // { force: true } to invalidate metaCacheRef 
    // before the refetch (preloaded=false => complete meta).
    // loopar.refresh() invokes it without payload (soft refetch, maintains cache).
    const handleRefresh = (opts) => {
      refreshRef.current(opts);
    };

    Emitter.on('refresh', handleRefresh);

    return () => {
      Emitter.off('refresh', handleRefresh);
    }
  }, []);

  const activePage = workspace.activePage || props.activePage || "";
  return (
    <>
      <DialogContextProvider key={activePage}/>
      <Loading/>
      <WorkspaceProviderContext.Provider
        value={{
          ...workspace,
          webApp: props.webApp || {},
          activePage: activePage,
        }}
      >
        {props.children}
      </WorkspaceProviderContext.Provider>
    </>
  );
}
