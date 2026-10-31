import { cn } from "@cn/lib/utils";
import React, {useEffect} from "react";
import {CookiesProvider} from '@services/cookie';
import {PersistStateProvider} from '@services/persist-state';
import { WorkspaceProvider } from "@workspace/workspace-provider";
import { useNavigate } from 'react-router';
import { RealtimeProvider } from "@services/realtime/RealtimeContext";
import { AuthProvider} from "@context/auth-context"
import { RouterBridge } from "@@tools/router/router-bridge";
import { UpdateBanner } from "@@tools/version/update-banner";

type ViewType = "module" | "app" | "page" | "list" | "view" | "form";
type Environment = "development" | "staging" | "production";

interface EntityInterface {
  name: string;
  doc_structure: string;
  id: string | number;
}

interface DocumentInterface {
  name: string;
  meta: {
    action: string;
    title: string;
    type?: ViewType;
    [key: string]: unknown;
  };
  data: Record<string, unknown>;
  Entity: EntityInterface;
  spacing: Record<string, unknown>;
  pathname: string
}

interface CookieOptions {
  expires?: Date | number;
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
}

interface CookieManager {
  get(key: string): string | undefined;
  set(key: string, value: string, options?: CookieOptions): void;
  remove(key: string): void;
}

interface RootLayoutProps {
  __META__: {
    name: string;
    services: {
      cookieManager: CookieManager;
    };
    environment: Environment;
    components: {
      Workspace: React.FC<any>;
      View: React.FC<any>;
    };
    Document: DocumentInterface;
    menu_data?: Record<string, unknown>;
    site: string,
    userId: string
  };
  pathname: string;
  permissions: ()=>{}
  primary?: boolean;
  onClose?: () => void;
  /** Modal mini-workspace only: called with the saved document's name after a form save. */
  onSaved?: (name: string, response?: unknown) => void;
}

const Main = ({ __META__, permissions, pathname, primary = true, onClose, onSaved }: RootLayoutProps) => {
  const { components, Document } = __META__;
  const { Workspace, View } = components;

  const navigate = useNavigate();
  
  useEffect(() => {
    if (!primary) return;
    const onPop = () => {
      const path = window.location.pathname;
      const isDesk = path.startsWith('/desk');
      const isAuth = !!localStorage.getItem('token');
      if (isDesk && !isAuth) {
        navigate('/auth/login', { replace: true });
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [navigate, primary]);
  
  const content = (
    <>
      {primary && <RouterBridge />}
      {primary && <UpdateBanner />}
      <main
        className={cn(
          "h-full font-sans antialiased"
        )}
      >
        <div className="relative flex flex-col">
          <div className="flex-1" translate="yes">
            <AuthProvider
              permissions={permissions}
              userId={__META__.userId}
            >
              <WorkspaceProvider
                primary={primary}
                onClose={onClose}
                onSaved={onSaved}
                __META__={__META__}
                Documents={Document ? {
                  [Document.name]: {
                    ...__META__,
                    View,
                    active: true
                  }
                } : {}}
                pathname={pathname}
              >
                <Workspace
                  menuData={__META__.menu_data}
                />
              </WorkspaceProvider>
            </AuthProvider>
          </div>
        </div>
      </main>
    </>
  );

  // The realtime socket is a global; only the primary (root) opens it. A modal
  // reuses the one already mounted in the base tree above.
  return primary
    ? <RealtimeProvider siteName={__META__.site} userId={__META__.userId}>{content}</RealtimeProvider>
    : content;
}

const App = ({ __META__, permissions, pathname, primary = true, onClose, onSaved }: RootLayoutProps) => {
  const [, setUpdate] = React.useState(false);
  const { cookieManager } = __META__.services;

  return (
    <>
      <CookiesProvider manager={cookieManager} updater={setUpdate}>
        <PersistStateProvider workspace={__META__.name} cookieManager={cookieManager}>
          <Main
            __META__={__META__}
            permissions={permissions}
            pathname={pathname}
            primary={primary}
            onClose={onClose}
            onSaved={onSaved}
          />
        </PersistStateProvider>
      </CookiesProvider>
    </>
  )
}

export default App;