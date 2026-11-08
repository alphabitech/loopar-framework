
'use strict';

import { ListLayout } from '@loopar/list';
import loopar, { useRealtime } from "loopar";
import DragToggle from "./DragToggle.jsx";
import { useState, useEffect, useRef, useMemo, createContext, useContext } from "react";

import {
  Avatar,
} from "@cn/components/ui/avatar"

import {Link} from "@link"
import {Button, buttonVariants} from "@cn/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@cn/components/ui/dropdown-menu";
import { Settings2Icon, EllipsisIcon, HardDrive, RefreshCw, Hammer, PackageIcon, RocketIcon, ChevronDown, RotateCcw, Trash2 } from 'lucide-react';

import {cn} from "@cn/lib/utils";

import { useDialogContext} from "@dialog";
import { useTable } from "@@table/TableContext"
import { useWorkspace } from "@workspace/workspace-provider";
import { __ } from "loopar";

const tenantStatus = (row, site) => {
  return row.status != "online" || site == row.name;
}

export const TenantManagerListContext = createContext();

const TenantManagerListProvider = ({children}) => {
  const [updateRows=[], setUpdateRows] = useState([]);
  return (
    <TenantManagerListContext.Provider value={{updateRows, setUpdateRows}}>
      {children}
    </TenantManagerListContext.Provider>
  )
}

const tenantBaseUrl = (row) => {
  const domain = row.domain || `${row.name}.localhost`;
  const isLocal = domain === 'localhost' || domain.endsWith('.localhost');
  return `${isLocal ? 'http' : 'https'}://${domain}`;
}

/**
 * Open a tenant in a new tab. The server decides the destination: its /desk
 * when installed, or the tokened install link while setup is pending (the
 * setup wizard rejects remote clients without the token). The tab is opened
 * synchronously so popup blockers don't eat it, then pointed at the URL.
 */
const openTenant = (row) => {
  const win = window.open('', '_blank');
  loopar.call("Tenant Manager", "openUrl", {
    query: { name: row.name },
    freeze: false,
    success: (res) => {
      const url = res?.url || `${tenantBaseUrl(row)}/desk`;
      if (win) { win.opener = null; win.location.href = url; }
      else window.location.href = url;
    },
    error: (message) => {
      win?.close();
      loopar.throw(message);
    },
  });
}

const NameRender = ({row}) => {
  const {inDialog} = useDialogContext();
  const {toggleRowSelect} = useTable();
  const { __META__ } = useWorkspace();
  const disabled = tenantStatus(row, __META__?.site);

  const to = `${tenantBaseUrl(row)}/desk`;

  return (
    <a 
      className={cn(
        // Same look the desk Link gave this row (inline-flex + link variant).
        "justify-normal cursor-pointer p-2",
        buttonVariants({ variant: "link" }).replaceAll("text-primary", ""),
        "justify-start",
        disabled && "opacity-50 "
      )}
      href={to}
      onClick={(e) => {
        e.preventDefault();
        if (inDialog) return toggleRowSelect(row);
        openTenant(row);
      }}
    >
      <Avatar>
        <div>
          <HardDrive
            className={
              cn(
                `w-8 h-8 transition-all ease-in duration-300 hover:scale-105 aspect-square`,
                row.status == "online" ? "text-green-500/70" : "text-red-500/70"
              )
            }
          />
        </div>
      </Avatar>
      <div className='flex flex-col items-start p-0 pl-3'>
        <span className='flex items-center gap-2'>
          {row.name.toUpperCase()}
          {!!Number(row.control_plane) && (
            <span className='rounded border border-primary/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary'>
              {__("Control plane")}
            </span>
          )}
        </span>
        <span className='text-gray-500'>{to}</span>
      </div>
    </a>
  )
}

const sendAction = (action, name, confirm=true, onComplete) => {
  const doAction = () => {
    loopar.call("Tenant Manager", action, {
      query: { name },
      success: () => {
        onComplete?.(true);
        loopar.refresh();
      },
      error: (message) => {
        onComplete?.(false);
        loopar.refresh();
        loopar.throw(message)
      },
      freeze: false
    });
  }

  if(confirm){
    loopar.confirm(`Are you sure you want to ${action} ${name}?`, () => {
      doAction();
    }, () => {
      onComplete?.(false);
    });
  }else{
    doAction();
  }
}

const DANGER = {
  reset: {
    title: "Reset",
    describe: (name) => `Drops ${name}'s database and forgets its connection and installed apps. ` +
      `The tenant (domain, websites, files) stays and opens the setup wizard again.`,
  },
  destroy: {
    title: "Delete",
    describe: (name) => `Drops ${name}'s database and deletes sites/${name} from disk. This can't be undone.`,
  },
};

/** Destructive tenant action, confirmed by typing the tenant name. */
const dangerAction = (action, name, setUpdateRows) => {
  const { title, describe } = DANGER[action];
  loopar.prompt({
    title: `${title} ${name}?`,
    label: `${describe(name)} Type "${name}" to confirm.`,
    placeholder: name,
    // The dialog runs `ok` before `validate`, so the name check lives here.
    ok: (value) => {
      if ((value || "").trim() !== name) {
        return loopar.notify({ message: `${title} cancelled: the name did not match.`, type: "warning" });
      }
      setUpdateRows(prev => [...prev, name]);
      sendAction(action, name, false, () => {
        setUpdateRows(prev => prev.filter(n => n != name));
      });
    },
  });
};

const Buttons = ({row}) => {
  const {inDialog} = useDialogContext();
  const {updateRows, setUpdateRows} = useContext(TenantManagerListContext);

  const loading = updateRows.includes(row.name);
  if(inDialog) {
    return null
  }

  const status = row.status;

  return (
    <div className="flex flex-row items-center gap-0">
      <Button
        variant="outline"
        title={__("Restart — re-initializes the tenant (fresh re-init, picks up code/env changes)")}
        disabled={status != "online" || loading}
        onClick={(e) => {
          e.preventDefault();
          setUpdateRows(prev => [...prev, row.name]);
          sendAction("restart", row.name, true, () => {
            setUpdateRows(prev => prev.filter(name => name != row.name));
          });
        }}
      >
        <RefreshCw className={`text-blue-500/70 ${loading && "animate-spin"}`} />
      </Button>
      <Link
        to={`update?name=${row.name}&app=${row.app}`}
      >
        <Button variant="outline">
          <Settings2Icon className="text-blue-500" />
        </Button>
      </Link>
      <DangerMenu row={row} loading={loading} setUpdateRows={setUpdateRows} />
    </div>
  );
}


const DangerMenu = ({ row, loading, setUpdateRows }) => {
  const { __META__ } = useWorkspace();
  // Control-plane tenants and the current workspace: the server refuses to reset/delete them.
  const locked = !!Number(row.control_plane) || row.name === __META__?.site;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          disabled={loading || locked}
          title={locked ? "Control-plane / current workspace — can't be reset or deleted" : "Reset or delete"}
        >
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => dangerAction("reset", row.name, setUpdateRows)}>
          <RotateCcw className="mr-2 h-4 w-4 text-amber-500" /> {__("Reset (drop database)")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => dangerAction("destroy", row.name, setUpdateRows)} className="text-red-500">
          <Trash2 className="mr-2 h-4 w-4" /> {__("Delete tenant")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// One deploy control. Primary click deploys the watcher's latest build (from
// build/staging — fast). The dropdown offers the same, plus a full rebuild +
// deploy (compressed, from scratch). Both are self-contained deploys — neither
// is a step that needs the other.
const DeployButton = () => {
  const [build, setBuild] = useState({ state: 'idle' });
  const notifiedRef = useRef(new Set());

  const notifyResult = (job) => {
    if (!job || (job.state !== 'completed' && job.state !== 'failed')) return;
    if (!job.id || notifiedRef.current.has(job.id)) return;
    notifiedRef.current.add(job.id);

    const what = job.scope === 'activate' ? 'Deploy' : 'Build';
    if (job.state === 'completed') {
      loopar.notify({ message: `${what} completed. Production tenants reloaded.`, type: "success" });
    } else {
      loopar.notify({
        message: `${what} failed${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}. Check server logs.`,
        type: "error",
      });
    }
  };

  // Sync from an actionBuildStatus response. Used on mount and as a polling
  // fallback: if the realtime socket drops mid-build (e.g. the dev server
  // chokes while a deploy floods build/releases with files), the completion
  // event is lost and the button would hang on "Deploying…" forever.
  const applyStatus = (res, { notify = true } = {}) => {
    if (!res || typeof res !== 'object') return;
    const b = res.build;
    if (b && b.state === 'running' && b.scope !== 'install') {
      setBuild(b);
      return;
    }
    const last = Array.isArray(res.history)
      ? res.history.find((h) => h.scope !== 'install')
      : null;
    if (last) {
      if (notify) notifyResult(last);
      else if (last.id) notifiedRef.current.add(last.id);
    }
    setBuild({ state: 'idle' });
  };

  useEffect(() => {
    let mounted = true;
    loopar.call("Tenant Manager", "buildStatus", {
      freeze: false,
      success: (res) => { if (mounted) applyStatus(res, { notify: false }); },
      error: () => {},
    });
    return () => { mounted = false; };
  }, []);

  useRealtime("buildStatus", (payload) => {
    if (!payload?.build) return;
    const next = payload.build;
    if (next.scope === 'install') return;
    setBuild(next.state === 'running' ? next : { state: 'idle' });
    notifyResult(next);
  });

  // Polling fallback while a job runs — heals missed realtime events.
  useEffect(() => {
    if (build.state !== 'running') return;
    const timer = setInterval(() => {
      loopar.call("Tenant Manager", "buildStatus", {
        freeze: false,
        success: (res) => applyStatus(res),
        error: () => {},
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [build.state]);

  const isRunning = build.state === 'running';
  const isBuilding = isRunning && build.scope !== 'activate';

  const post = (action, scope) => {
    setBuild({ state: 'running', scope, startedAt: Date.now() });
    loopar.call("Tenant Manager", action, {
      freeze: false,
      success: (res) => { if (res && res.build) setBuild(res.build); },
      error: (msg) => { setBuild({ state: 'idle' }); loopar.throw(msg); },
    });
  };

  const deployStaging = () => {
    if (isRunning) return;
    loopar.confirm(
      "Deploy the latest build (from staging) and reload production tenants?",
      () => post('activate', 'activate')
    );
  };

  const fullRebuild = () => {
    if (isRunning) return;
    loopar.confirm(
      "Full rebuild (compressed) and deploy? Slower — rebuilds everything from scratch.",
      () => post('build', 'all')
    );
  };

  const variant = isRunning ? "outline" : "primeblue";
  const label = isRunning ? (isBuilding ? 'Building…' : 'Deploying…') : 'Deploy';

  return (
    <div className="flex items-center">
      <Button
        variant={variant}
        onClick={deployStaging}
        disabled={isRunning}
        className="rounded-r-none"
        title={__("Deploy the latest watcher build (from staging) and reload tenants")}
      >
        <RocketIcon className={`mr-2 ${isRunning ? "animate-pulse" : ""}`} />
        {label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            disabled={isRunning}
            className="rounded-l-none border-l border-white/20 px-2"
            title={__("Deploy options")}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={deployStaging}>
            <RocketIcon className="mr-2 h-4 w-4" /> {__("Deploy (from staging — fast)")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={fullRebuild}>
            <Hammer className="mr-2 h-4 w-4" /> {__("Full rebuild & deploy")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

const InstallButton = () => {
  const [running, setRunning] = useState(false);
  const notifiedRef = useRef(new Set());

  const notifyResult = (job) => {
    if (!job || job.scope !== 'install') return;
    if (!job.id || notifiedRef.current.has(job.id)) return;
    if (job.state === 'completed') {
      notifiedRef.current.add(job.id);
      loopar.notify({ message: "Dependencies installed. You can build now.", type: "success" });
    } else if (job.state === 'failed') {
      notifiedRef.current.add(job.id);
      loopar.notify({
        message: `Install failed${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}. Check server logs.`,
        type: "error",
      });
    }
  };

  useRealtime("buildStatus", (payload) => {
    const b = payload?.build;
    if (!b || b.scope !== 'install') return;
    setRunning(b.state === 'running');
    notifyResult(b);
  });

  // Polling fallback — same rationale as DeployButton: don't hang on
  // "Installing…" if the completion event is missed.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      loopar.call("Tenant Manager", "buildStatus", {
        freeze: false,
        success: (res) => {
          const b = res?.build;
          if (b && b.state === 'running' && b.scope === 'install') return; // still going
          const last = Array.isArray(res?.history)
            ? res.history.find((h) => h.scope === 'install')
            : null;
          if (last) notifyResult(last);
          setRunning(false);
        },
        error: () => {},
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [running]);

  const onClick = (e) => {
    e.preventDefault();
    if (running) return;
    loopar.confirm(
      "Run 'yarn install' now? Installs new/updated dependencies from the lockfile. Run this when libraries changed, before building.",
      () => {
        setRunning(true);
        loopar.call("Tenant Manager", "install", {
          freeze: false,
          success: () => {},
          error: (msg) => { setRunning(false); loopar.throw(msg); },
        });
      }
    );
  };

  return (
    <Button
      variant={running ? "outline" : "secondary"}
      onClick={onClick}
      disabled={running}
      title={__("Install dependencies (yarn install) — run when libraries changed, before building")}
    >
      <PackageIcon className={`mr-2 ${running ? "animate-pulse" : ""}`} />
      {running ? "Installing…" : "Install"}
    </Button>
  );
};

const CoreModeToggle = () => {
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    loopar.call("Tenant Manager", "coreStatus", {
      freeze: false,
      success: (res) => { if (mounted) setMode(res?.mode || 'development'); },
      error: () => {},
    });
    return () => { mounted = false; };
  }, []);

  if (mode === null) return null;

  const flip = (isProd, revert) => {
    const target = isProd ? 'production' : 'development';
    loopar.confirm(
      `Switch the CORE to ${target} and restart? Every tenant disconnects for a moment.` +
      (isProd ? ' Production serves the built dist — make sure you deployed.' : ''),
      () => {
        setBusy(true);
        loopar.call("Tenant Manager", isProd ? "coreProd" : "coreDev", {
          freeze: false,
          success: () => { 
            setMode(target); 
            setTimeout(() => {
              setBusy(false); setBusy(false); 
              window.location.reload()
            }, 2000)
          },
          error: (msg) => { setBusy(false); revert?.(); loopar.throw(msg); },
        });
      },
      () => revert?.()
    );
  };

  return (
    <DragToggle
      value={mode === 'production'}
      site="__core__"
      disabled={busy}
      onChange={flip}
      offLabel="Dev"
      onLabel="Prod"
      offColor="amber"
      onColor="blue"
      className="h-10"
    />
  );
};

const ACTIONS = {
  coremode: <CoreModeToggle />,
  install: <InstallButton />,
  deploy: <DeployButton />,
};

export const config = { onlyList: true };

const TenantManagerList = () => {
  const { updateRows, setUpdateRows } = useContext(TenantManagerListContext);

  const columns = useMemo(() => (baseColumns) => [
    {
      data: {
        name: "name:"
      },
      render: row => (
        <NameRender row={row} />
      ),
    },
    {
      data: {
        name: "status:",
        label: "Status"
      },
      headProps: {
        className: "w-10 p-2 text-center",
      },
      cellProps: {
        className: "w-10 p-2 text-center",
      },
      render: row => {
        const status = row.status;
      
        return (
          <DragToggle
            value={status=="online"}
            site={row.name}
            disabled={updateRows.includes(row.name)}
            onChange={(isOnline, revert) => {
              setUpdateRows(prev => [...prev, row.name]);
              sendAction(isOnline ? "start" : "stop", row.name, false, (ok) => {
                if (!ok) revert?.();
                setUpdateRows(prev => prev.filter(name => name != row.name))
              });
            }}
          />
        )
      }
    },
    ...baseColumns,
    {
      data: {
        label: () => <EllipsisIcon className="w-full"/>,
        name: "actions",
      },
      headProps: {
        className: "w-10 p-2 text-center",
      },
      render: row => (
        <Buttons row={row} />
      ),
    }
], [updateRows, setUpdateRows]);

  return <ListLayout actions={ACTIONS} columns={columns} />;
};

const TenantManagerMiddleware = () => {
  return (
    <TenantManagerListProvider>
      <TenantManagerList />
    </TenantManagerListProvider>
  )
}

export default TenantManagerMiddleware;