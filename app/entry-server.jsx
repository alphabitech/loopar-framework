import React from "react";
import { renderToPipeableStream } from "react-dom/server";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import App from "./App.tsx";
import { StaticRouter } from "react-router";
import { Loader } from "@loopar/loader";
import { ServerCookiesManager } from '@services/cookie';
import { RenderedComponents } from "@loopar/components-loader";

/** A render that never settles (a module that never resolves) is cut here. */
const SSR_TIMEOUT_MS = Number(process.env.SSR_TIMEOUT_MS ?? 10000);

const Main = ({ __META__, pathname, context, req, res, permissions, rendered }) => {
  const cookieManager = new ServerCookiesManager(req, res);

  return (
    <React.StrictMode>
      <RenderedComponents.Provider value={rendered}>
        <StaticRouter
          location={pathname}
          context={context}
        >
          <App
            __META__={{
              ...__META__,
              services: { cookieManager },
              environment: "server"
            }}
            permissions={permissions}
            pathname={pathname}
          />
        </StaticRouter>
      </RenderedComponents.Provider>
    </React.StrictMode>
  );
};

/**
 * renderToPipeableStream, buffered until `onAllReady`: React waits for every
 * <Suspense> (element modules loaded through `use()`), so the HTML is complete
 * — what SEO and hydration need — and the caller gets a string as before.
 *
 * Errors inside a boundary don't fail the page: React leaves that boundary for
 * the client to render (logged here). An error outside every boundary (the
 * shell) rejects, like renderToString used to throw.
 */
function renderToHTML(element) {
  return new Promise((resolve, reject) => {
    let html = "";
    const decoder = new StringDecoder("utf8");   // chunks may split a multi-byte char

    const sink = new Writable({
      write(chunk, _encoding, callback) {
        html += typeof chunk === "string" ? chunk : decoder.write(chunk);
        callback();
      },
      final(callback) {
        html += decoder.end();
        callback();
      },
    });

    let timer = null;
    sink.on("finish", () => { clearTimeout(timer); resolve(html); });
    sink.on("error", (error) => { clearTimeout(timer); reject(error); });

    const { pipe, abort } = renderToPipeableStream(element, {
      // Every element has its own <Suspense>. Without this, React moves any
      // finished boundary bigger than ~12.8 KB out of place (hidden, revealed
      // by an inline script after paint) even when piping at onAllReady.
      progressiveChunkSize: Number.POSITIVE_INFINITY,
      onAllReady() {
        pipe(sink);
      },
      onShellError(error) {
        clearTimeout(timer);
        reject(error);
      },
      onError(error) {
        console.error("[SSR]", error);
      },
    });

    timer = setTimeout(() => abort(new Error(`SSR timed out after ${SSR_TIMEOUT_MS}ms`)), SSR_TIMEOUT_MS);
  });
}

export async function render(pathname, __META__, req, res, permissions) {
  // Workspace, view and the elements listed in doc_structure, preloaded so the
  // render rarely has to suspend; anything else is awaited by React itself.
  const { Workspace, View } = await Loader(__META__, "server");
  global.ENVIRONMENT = "server";

  const context = {};
  const rendered = new Set();

  const HTML = await renderToHTML(
    <Main
      pathname={pathname}
      __META__={{
        ...__META__,
        components: { Workspace, View }
      }}
      req={req}
      res={res}
      permissions={permissions}
      rendered={rendered}
    />
  );

  if (context.url) {
    return {
      redirect: context.url,
    };
  }

  // The client loads these before hydrating (MetaComponentsLoader).
  __META__.__REQUIRE_COMPONENTS__ = [...rendered];
  return {
    HTML
  };
}
