import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App.tsx";
import { Loader } from "@loopar/loader";
import { ErrorBoundary } from "@error-boundary";
import { versionWatch } from "@@tools/version/version-watch";
import { draftStore } from "@@tools/version/draft-store";

(async () => {
  const __META_SCRIPT__ = document.getElementById('__loopar-meta-data__');
  const __META__ = JSON.parse(__META_SCRIPT__?.textContent || "{}");
  globalThis.__INSTALLED_APPS__ = __META__.__INSTALLED_APPS__;
  globalThis.__csrfToken__ = __META__.csrfToken ?? undefined;
  // Signed workspace identity — echoed back on every RPC as X-Workspace-Token.
  globalThis.__wsToken__ = __META__.wsToken ?? undefined;
  globalThis.__user__ = __META__.user?.name;
  globalThis.__site__ = __META__.site ?? undefined;

  // Version skew guard: compare every response's build with the one we booted
  // with, and recover from chunks of an old bundle (see version-watch).
  versionWatch.init(__META__.build);
  // Drafts housekeeping: expired ones, and other users' drafts on this site.
  draftStore.prune({ site: __META__.site, user: __META__.user?.name });

  const { Workspace, View } = await Loader(__META__, "client");

  window.lastY = 0;
  window.verticalDirection = null;

  ReactDOM.hydrateRoot(
    document.getElementById("__[loopar-root]__"),
    <BrowserRouter>
      <ErrorBoundary>
        <App
          __META__={{
            ...__META__,
            components: {Workspace, View},
            environment: "client",
            services: {}
          }}
          permissions={__META__.permissions}
          pathname={window.location.pathname}
        />
      </ErrorBoundary>
    </BrowserRouter>
  );
})();