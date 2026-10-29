const __META_COMPONENTS__ = {};
import { createContext, use, useContext } from "react";
import loopar from "loopar";
import {MetaComponents} from "@global/require-components";
import { MetaLoadError } from "./components/meta/meta-load-error";

const components = Object.entries(import.meta.glob(['./components/*.jsx'])).reduce((acc, [path, module]) => {
  acc['src/' + path.split('/').pop().replace('.jsx', '')] = module;
  return acc;
}, {});

function makeFailedComponent(component, error) {
  const Failed = () => <MetaLoadError element={component} error={error} />;
  return { default: Failed, __loadFailed: true, error };
}

function getComponent(component) {
  if(!component) return null;
  const cParse = component.replaceAll(/_/g, "-");

  return new Promise((resolve) => {
    const cached = __META_COMPONENTS__[component];
    if (cached && !cached.__loadFailed) {
      resolve(cached);
      return;
    }

    const moduleImport = components[`src/${cParse}`] || components[`src/generic`] || null;
    if(!moduleImport) {
      console.warn("Component not found: " + component);
      resolve(null);
      return;
    }

    const onFailure = (error) => {
      console.error(`Failed to load component "${component}"`, error);
      const failed = makeFailedComponent(component, error);
      __META_COMPONENTS__[component] = failed;
      resolve(failed);
    };

    moduleImport().then((c) => {
      const promises = [];

      if (c?.default?.prototype?.requires && typeof window !== "undefined") {
        const requires = c.default.prototype.requires;

        if (requires.css) {
          for (const css of requires.css) {
            promises.push(loopar.includeCSS(css));
          }
        }

        if (requires.js) {
          for (const js of requires.js) {
            promises.push(loopar.require(js));
          }
        }

        if (requires.modules) {
          promises.push(
            ComponentsLoader(requires.modules.filter((m) => m !== component))
          );
        }
      }

      Promise.all(promises).then(() => {
        if(c.default) {
          __META_COMPONENTS__[component] = c;
          resolve(c);
        }else{
          resolve(null)
        }
      }).catch(onFailure);
    }).catch(onFailure);
  });
}

async function ComponentsLoader(components, callback) {
  const promises = Array.from(new Set(components)).map((c) => getComponent(c));
  return Promise.all(promises).then(callback);
}

/**
 * One thenable per element, reused across renders (`use()` needs a stable one).
 * Already-loaded modules get a thenable marked fulfilled, which `use()` reads
 * synchronously — so `use()` is called on every render, never skipped after a
 * suspend (React requires that).
 */
const inflight = {};
const fulfilled = (value) => Object.assign(Promise.resolve(value), { status: "fulfilled", value });

function loadMetaModule(name) {
  if (inflight[name]) return inflight[name];

  const cached = __META_COMPONENTS__[name];
  if (cached && !cached.__loadFailed) return (inflight[name] = fulfilled(cached));

  const pending = getComponent(name).then((value) => {
    if (!value?.__loadFailed || typeof window !== "undefined") return value;
    // Server: a failed import is not kept (the next render imports again, so a
    // transient failure such as a release swap doesn't stick for the life of
    // the process) and is thrown, so React leaves this element's boundary for
    // the client to render. The client keeps the error placeholder.
    delete inflight[name];
    throw value.error || new Error(`Failed to load component "${name}"`);
  });
  // Handlers return nothing: returning `pending` itself would adopt its
  // rejection and leave an unhandled rejection behind.
  pending.then(
    (value) => { Object.assign(pending, { status: "fulfilled", value }); },
    (reason) => { Object.assign(pending, { status: "rejected", reason }); },
  );
  return (inflight[name] = pending);
}

/**
 * Request-scoped Set of the elements a server render used (entry-server provides
 * it). Sent to the client as `__REQUIRE_COMPONENTS__` so hydration starts with
 * them already loaded. Only an optimisation: a missing one just suspends.
 */
const RenderedComponents = createContext(null);

/**
 * The element's module, suspending (server and client) until it is loaded.
 * Callers sit inside a <Suspense>: on the server React waits for it, on the
 * client hydration keeps the server HTML of that boundary until it arrives.
 * `load: false` (designer-only elements outside the designer) → null.
 */
function useMetaModule(name, load = true) {
  const rendered = useContext(RenderedComponents);
  if (!load || !name) return null;

  rendered?.add(name);
  return use(loadMetaModule(name));
}

/**
 * Client navigation: load the new document's elements before it is shown, so
 * the page swaps in complete instead of suspending per element (React 19
 * throttles Suspense reveals ~300ms). Best effort — anything missed suspends.
 */
async function DocumentComponentsLoader(__META__) {
  try {
    await ComponentsLoader(MetaComponents(__META__, "client"));
  } catch {
    // incomplete meta (e.g. error view): the render loads what it needs
  }
}

async function MetaComponentsLoader(__META__, environment) {
  await ComponentsLoader(environment === "server" ? MetaComponents(__META__, environment) : __META__.__REQUIRE_COMPONENTS__);
}

export { MetaComponentsLoader, DocumentComponentsLoader, __META_COMPONENTS__, ComponentsLoader, RenderedComponents, useMetaModule };
