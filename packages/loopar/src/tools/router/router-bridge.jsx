import { useEffect } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import loopar from "loopar";
import { scrollMemory } from "@@tools/router/scroll-memory";

/**
 * Bridge between react-router and the singleton `loopar`.
 *
 * `loopar` is instantiated at module level (singleton) and therefore cannot
 * access the `useNavigate` hook directly. This component lives inside the
 * react-router tree, obtains the `navigate` via the hook and registers it in
 * the singleton so that any code outside the React tree (controllers, callbacks,
 * imperative code) can call `loopar.navigate(url)` and get a real SPA navigation.
 *
 * It also tells the scroll memory how every location was reached (link vs
 * back/forward), so the next document opens at the top or where it was left.
 *
 * It is mounted only once, as close as possible to the root, inside
 * <BrowserRouter> (or <StaticRouter> in SSR; in SSR the useEffect does not run,
 * so the bind never occurs — desired behavior).
 */
export function RouterBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    loopar._bindRouter({ navigate });
    return () => loopar._unbindRouter();
  }, [navigate]);

  useEffect(() => {
    scrollMemory.navigated(location, navigationType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, location.pathname, location.search]);

  return null;
}

export default RouterBridge;
