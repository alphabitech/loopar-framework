import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, useTransition } from "react"
import { loopar } from "loopar";
import { useLocation } from 'react-router';
import { useCookies } from "@services/cookie";
import { usePersist } from "@services/persist-state";
import { AppSourceLoader } from "@loopar/loader";
import {useAuth} from "@context/auth-context"
import Emitter from "@services/emitter/emitter";
import { LoopSocket } from "@services/realtime/LoopSocket";
import { navTrace } from "@@tools/router/nav-trace";

/** Read the current public session (JWT is httpOnly → ask the server). */
async function fetchSession() {
  try {
    const r = await fetch("/auth/me", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: "{}",
    }).then((x) => x.json());
    return r?.logged ? r : null;
  } catch {
    return null;
  }
}

const initialState = {
  theme: "system",
  setTheme: () => null,
  openNav: loopar.cookie.get("openNav"),
  setOpenNav: () => null,
  ActiveView: null,
  setDocuments: () => null,
  activePage: "",
  setActivePage: () => null,
  activeModule: "",
  setActiveModule: () => null,
  pathname: "",
  award: () => null
}

export const WorkspaceProviderContext = createContext(initialState)

export function WorkspaceProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  sourceStorageKey = "vite-ui-theme-source",
  ...props
}) {
  const [storedTheme, setStoredTheme] = useCookies(storageKey);
  const [storedSource, setStoredSource] = useCookies(sourceStorageKey);

  const setTheme = useCallback((value) => {
    setStoredTheme(value);
    setStoredSource("manual");
  }, [setStoredTheme, setStoredSource]);

  const __META__ = props.__META__ || {}
  const __WORKSPACE_NAME__ = __META__.name || "desk"

  const [Documents, setDocuments] = useState(props.Documents || {});
  const [loaded, setLoaded] = useState(false);
  const [activePage, setActivePage] = useState(props.activePage || "");
  const [activeModule, setActiveModule] = useState(null);
  const [refreshFlag, setRefreshFlag] = useState(false);
  const [isPending, startTransition] = useTransition();
  const {award} = useAuth();

  const [pathname, setPathname] = useState(
    props.pathname || (typeof window !== "undefined" ? window.location.pathname + window.location.search : "")
  );

  // Reactive session: seeded from SSR, refreshed in place on auth changes.
  const [user, setUser] = useState(__META__.user || null);

  // A secondary provider (modal mini-workspace) reuses render + navigation,
  // but only the PRIMARY touches global singletons (workspace bind, session,
  // socket, window.__user__).
  const primary = props.primary !== false;
  const onClose = props.onClose;
  // Modal-only: notifies the modal's opener that a form inside it saved a
  // document (BaseForm.save calls it with the document name). Same threading
  // path as onClose: EntryModal → App → here → View.
  const onSaved = props.onSaved;
  const seeded = Object.keys(props.Documents || {}).length > 0;

  // Singleton binds — only the provider knows the active workspace and
  // session, so only it pushes them into `loopar`.
  useEffect(() => {
    if (!primary) return;
    loopar._bindWorkspace(__WORKSPACE_NAME__);
  }, [__WORKSPACE_NAME__, primary]);

  useEffect(() => {
    if (!primary) return;
    loopar._bindSession(user);
  }, [user, primary]);
  useEffect(() => {
    if (!primary) return;
    const onAuthChanged = () => { fetchSession().then(setUser); };
    Emitter.on("auth:changed", onAuthChanged);
    return () => Emitter.off("auth:changed", onAuthChanged);
  }, [primary]);

  // Realtime: connect to this tenant's namespace (`__META__.site`); identity
  // comes from the httpOnly JWT. Without this call nothing ever connects and
  // useRealtime()'s onReady callbacks queue forever.
  useEffect(() => {
    if (!primary) return;
    const site = __META__.site;
    if (!site) return;
    LoopSocket.connect(site);
  }, [__META__.site, primary]);

  // useRealtime({ ignoreSelf }) compares payload.user vs window.__user__;
  // keep it in sync with the session.
  useEffect(() => {
    if (!primary) return;
    if (typeof window !== "undefined") {
      window.__user__ = user?.userId || user?.name || null;
    }
  }, [user, primary]);

  const metaCacheRef = useRef({});
  const lastFetchedPath = useRef(null);
  const fetchIdRef = useRef(0);
  const isInitialMount = useRef(true);

  const location = useLocation();
  useEffect(() => {
    // Only the primary follows the browser URL; a modal drives its pathname locally.
    if (!primary) return;
    const newPath = location.pathname + location.search;
    setPathname(newPath);
  }, [location.pathname, location.search, primary]);

  // Navigation for consumers: primary → the real URL/router; a modal advances
  // its own in-memory path, never touching the browser URL.
  const navigate = useCallback((to) => {
    if (primary) return loopar.navigate(to);
    setPathname(typeof to === "string" ? to : String(to ?? ""));
  }, [primary]);

  const memoizedActiveView = useMemo(() => {
    // `inModal` lets a View skip full-page behaviour (e.g. URL normalizing,
    // which from a modal would navigate the base page away).
    return Object.values(Documents)
      .filter(doc => doc.active)
      .map(doc => {
        const { View } = doc;
        return View && <View Document={doc.Document} inModal={!primary} onClose={onClose} onSaved={onSaved} key={doc.key} />;
      });
  }, [Documents, primary, onClose, onSaved]);

  const [openNav, setOpenNav] = usePersist(__WORKSPACE_NAME__);
  const ActiveView = useMemo(() => memoizedActiveView, [memoizedActiveView, refreshFlag]);

  const handleSetOpenNav = useCallback((newOpenNav) => {
    setOpenNav(newOpenNav);
  }, [setOpenNav]);

  const handleToogleSidebarNav = useCallback(() => {
    setOpenNav(prev => !prev);
  }, [setOpenNav]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const detect = () =>
      window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

    if (!storedTheme || storedTheme === "system") {
      setStoredTheme(detect());
      setStoredSource("auto");
      return;
    }

    if (!storedSource) {
      setStoredSource("manual");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (storedSource !== "auto") return;

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => setStoredTheme(e.matches ? "dark" : "light");

    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [storedSource, setStoredTheme]);
  
  useEffect(() => {
    if (typeof window === "undefined") return;
    const resolved =
      storedTheme === "light" || storedTheme === "dark"
        ? storedTheme
        : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolved);
  }, [storedTheme, pathname]);

  // A fetch is "current" while no newer navigation/refresh has started.
  // Checked AFTER every async step (fetch, then the lazy view import): a slow
  // chunk of an older document must never land on top of a newer one — that
  // rendered a previous page under the current URL.
  const isCurrentFetch = (fetchId) => fetchId === undefined || fetchId === fetchIdRef.current;

  // One atomic swap: deactivate everything and activate `entry` in the SAME
  // state update (two separate transitions could interleave between
  // concurrent loads and leave two views active, or the wrong one).
  const activateDocument = useCallback((entry) => {
    startTransition(() => {
      setDocuments(prevDocuments => {
        const next = {};
        for (const [k, doc] of Object.entries(prevDocuments)) {
          next[k] = doc.active ? { ...doc, active: false } : doc;
        }
        next[entry.key] = { ...entry, active: true };
        return next;
      });
    });
  }, []);

  const goToErrorView = useCallback((e, fetchId) => {
    const Document = {
      key: "error-view",
      entryPoint: "error-view",
      data: {
        code: e.code || 404,
        title: e.title || "Source not found",
        message: e.message,
        description: e.message,
        ...(e.frame ? { frame: e.frame } : {}),
        ...(e.stack && typeof e.stack === "string" ? { stack: e.stack } : {}),
      }
    };

    AppSourceLoader(Document).then((Module) => {
      if (!isCurrentFetch(fetchId)) return;
      navTrace('render-error', { code: Document.data.code, message: e.message });
      activateDocument({
        View: Module.default,
        key: Document.key,
        Document,
      });
    });
  }, [activateDocument]);

  const loadDocument = useCallback((__META__, Module) => {
    try {
      activateDocument({ View: Module.default, ...__META__ });
    } catch (err) {
      goToErrorView(err);
    }
  }, [activateDocument, goToErrorView]);

  const setDocument = useCallback((r, fetchId, path) => {
    const cache = metaCacheRef.current;
    let __META__ = {};

    if (cache[r.instance]) {
      __META__ = cache[r.instance];
      __META__.Document = { ...cache[r.instance].Document, ...r }
    } else {
      __META__ = {
        key: r.key,
        Document: r,
      }
      cache[r.instance] = __META__
    }

    AppSourceLoader(__META__.Document).then((Module) => {
      if (!isCurrentFetch(fetchId)) {
        navTrace('stale-document-dropped', { path, key: __META__.key });
        return;
      }
      navTrace('render', { path, key: __META__.key, entity: __META__.Document?.Entity?.name });
      loadDocument(__META__, Module);
    }).catch(e => goToErrorView(e, fetchId));
  }, [loadDocument, goToErrorView]);

  // Transient server states (tenant restarting / re-initializing, app being
  // (re)installed) answer 502/503/504: retry the SAME navigation quietly a few
  // times before showing the error view. Never retries over a newer navigation.
  const RETRYABLE = [502, 503, 504];
  const MAX_RETRIES = 6;

  const fetchDocument = useCallback((url, { attempt = 0, forceMeta = false } = {}) => {
    // Works off the path string alone (router location for the base,
    // in-memory path for a modal) — one code path, no second <Router>.
    const raw = String(url ?? '');
    if (raw.includes('#')) return Promise.resolve();

    const [rawPath, rawSearch = ''] = raw.split('?');
    const targetPath = rawPath || '/';
    const targetSearch = rawSearch ? `?${rawSearch}` : '';

    const currentFetchId = ++fetchIdRef.current;
    const preloadedMeta = !forceMeta && !!metaCacheRef.current[loopar.utils.urlInstance({ pathname: targetPath })];

    // The ONLY request that names a workspace (as a parameter) — RPCs never send one.
    const queryParams = Object.fromEntries(new URLSearchParams(targetSearch));

    return new Promise((resolve) => {
      loopar.fetchDocument(targetPath, {
        workspace: __WORKSPACE_NAME__,
        query: { ...queryParams, preloaded: preloadedMeta },
        // The error view below is the UI for a failed navigation — no toast.
        notifyError: false,
        success: r => {
          if (currentFetchId !== fetchIdRef.current) return resolve();

          // We asked for data only (meta cached) but the response carries no
          // meta we hold → ask once more for the full meta instead of
          // rendering a keyless/partial document.
          if (preloadedMeta && r && !r.key && !metaCacheRef.current[r.instance]) {
            navTrace('meta-cache-miss', { path: raw, instance: r.instance });
            return resolve(fetchDocument(url, { attempt, forceMeta: true }));
          }

          lastFetchedPath.current = raw;
          setDocument(r, currentFetchId, raw);
          resolve();
        },
        error: e => {
          if (currentFetchId !== fetchIdRef.current) return resolve();

          const code = Number(e?.code || e?.status);
          if (RETRYABLE.includes(code) && attempt < MAX_RETRIES) {
            const delay = Math.min(500 * 2 ** attempt, 4000);
            navTrace('retry', { path: raw, code, attempt: attempt + 1, delay });
            setTimeout(() => {
              // A newer navigation started meanwhile → it owns the view now.
              if (currentFetchId !== fetchIdRef.current) return resolve();
              resolve(fetchDocument(url, { attempt: attempt + 1, forceMeta }));
            }, delay);
            return;
          }

          // Retries exhausted and the server says a full page load would go
          // to a system page (pending update): go there, remembering where we
          // were, instead of leaving an error view under the current URL.
          if (RETRYABLE.includes(code) && typeof e?.requires === 'string' && primary) {
            const here = window.location.pathname + window.location.search;
            const dest = `${e.requires}?redirect=${encodeURIComponent(here)}`;
            navTrace('system-detour', { path: raw, to: dest });
            window.location.replace(dest);
            return resolve();
          }

          lastFetchedPath.current = raw;
          goToErrorView(e, currentFetchId);
          resolve();
        }
      });
    });
  }, [setDocument, goToErrorView, __WORKSPACE_NAME__]);

  /**
   * Re-fetch the active document. force:true clears the meta cache so the
   * server returns full meta — fields, permissions, actions (`loopar.reload()`);
   * default keeps it and gets lightweight data + shallow merge (`loopar.refresh()`).
   */
  const refresh = useCallback((opts = {}) => {
    if (opts.force) metaCacheRef.current = {};
    fetchDocument(pathname).then(() => {
      setRefreshFlag(prev => !prev);
    });
  }, [pathname, fetchDocument]);

  const getActiveDocument = useCallback(() => {
    return (Object.values(Documents).find(Document => Document.active) || {}).Document
  }, [Documents]);

  const getActiveParentMenu = useCallback(() => {
    const Document = getActiveDocument();
    return Document?.activeParentMenu || Document?.Entity?.name;
  }, [getActiveDocument]);

  const getTheme = useCallback(() => {
    if (storedTheme === "light" || storedTheme === "dark") return storedTheme;

    const cookieTheme = loopar.cookie.get(storageKey);
    if (cookieTheme === "light" || cookieTheme === "dark") return cookieTheme;

    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "dark";
  }, [storedTheme, storageKey]);

  useEffect(() => {
    setTimeout(() => {
      setLoaded(true);
    }, 100);
    
    if (!lastFetchedPath.current && seeded) {
      lastFetchedPath.current = pathname;
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;

    if (isInitialMount.current) {
      isInitialMount.current = false;
      if (seeded) return;   // not seeded (modal) → fall through and fetch the initial path
    }

    if (lastFetchedPath.current === pathname) return;

    fetchDocument(pathname);

    if (__WORKSPACE_NAME__ === "web") {
      setOpenNav(false);
    }
  }, [pathname, loaded, fetchDocument, __WORKSPACE_NAME__]);

  useEffect(() => {
    const Document = getActiveDocument();
    if (!Document) return;

    const entity = Document.Entity || {};
    const activeParentMenu = Document.activeParentMenu || entity?.name;
    const moduleName = (activeParentMenu !== "Module" ? Document?.meta?.module || entity?.module : null) || null;

    if (activeParentMenu) {
      const activeDocumentName = entity?.name;
      if (activeDocumentName && activeDocumentName !== activePage) {
        setActivePage(activeDocumentName);
      }
    }

    setActiveModule(moduleName);
  }, [ActiveView, getActiveDocument, activePage]);

  const value = useMemo(() => ({
    theme: getTheme(),
    __META__,
    setTheme,
    openNav,
    setOpenNav: handleSetOpenNav,
    toogleSidebarNav: handleToogleSidebarNav,
    menuItems: props.menuItems,
    activeParentMenu: getActiveParentMenu(),
    ENVIRONMENT: __META__.environment || props.ENVIRONMENT,
    ActiveView,
    activePage,
    activeModule,
    refresh,
    isPending,
    workspace: __WORKSPACE_NAME__,
    pathname,
    award,
    user,
    navigate,
    isModal: !primary,
    onClose
  }), [
    getTheme,
    __META__,
    setTheme,
    openNav,
    handleSetOpenNav,
    handleToogleSidebarNav,
    props.menuItems,
    getActiveParentMenu,
    ActiveView,
    activePage,
    activeModule,
    refresh,
    isPending,
    pathname,
    award,
    user
  ]);

  return (
    <WorkspaceProviderContext.Provider value={value}>
      {children}
    </WorkspaceProviderContext.Provider>
  )
}

export const useWorkspace = () => {
  const context = useContext(WorkspaceProviderContext)

  if (context === undefined)
    throw new Error("useWorkspace must be used within a WorkspaceProvider")

  return context
}