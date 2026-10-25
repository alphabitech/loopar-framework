import { Entry, entries } from "./document/Entry";
import { DefaultView } from "./document/base/provider";
import { WorkspaceLoader } from "@loopar/workspace-loader";
import { MetaComponentsLoader } from "@loopar/components-loader";
import { useEffect, lazy, useState } from "react";
import { loopar } from "loopar";
import { LoaderCircleIcon } from "lucide-react";


const Fallback = () => (
  <div className="flex flex-row justify-center items-center h-full">
    <LoaderCircleIcon className="animate-spin" size={150} />
  </div>
);

const ErrorMessage = (props) => {
  return (
    <div className="flex items-center justify-center h-full p-4">
      <div className="border-l-4 border-red-500 bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 max-w-3xl w-full">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <svg 
              className="h-6 w-6 text-red-500 dark:text-red-400" 
              fill="none" 
              viewBox="0 0 24 24" 
              stroke="currentColor"
            >
              <path 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                strokeWidth={2} 
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" 
              />
            </svg>
          </div>
          
          <div className="ml-3 flex-1">
            <h3 className="text-lg font-semibold text-red-800 dark:text-red-400 mb-2">
              ⚠️ Your View Component Failed to Load
            </h3>
            
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4 mb-4">
              <p className="text-sm text-red-800 dark:text-red-300 font-medium mb-2">
                <strong>Error:</strong> Unable to load component entry point
              </p>
              <p className="text-sm text-red-700 dark:text-red-400">
                The component specified in <code className="bg-red-100 dark:bg-red-950 px-1.5 py-0.5 rounded text-xs font-mono text-red-800 dark:text-red-300">.entryPoint</code> could not be found or loaded.
              </p>
            </div>

            <div className="space-y-3 mb-4">
              <div>
                <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">
                  🔍 Troubleshooting Steps:
                </h4>
                <ul className="text-sm text-gray-700 dark:text-gray-300 space-y-1 list-disc list-inside ml-2">
                  <li>Verify the component path in <code className="bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded text-xs font-mono">.entryPoint</code></li>
                  <li>Ensure the component file exists and is properly exported</li>
                  <li>Check for typos in the component name or import path</li>
                  <li>Confirm all dependencies are installed</li>
                </ul>
              </div>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">
                📄 Document Meta Configuration:
              </h4>
              <div className="bg-gray-900 dark:bg-gray-950 rounded-lg p-4 overflow-auto max-h-96 border border-gray-700">
                <pre className="text-xs text-green-400 dark:text-green-300 font-mono">
                  <code>{JSON.stringify({meta: props.Document || {}}, null, 2)}</code>
                </pre>
              </div>
            </div>

            <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
              <p className="text-xs text-blue-800 dark:text-blue-300">
                <strong>💡</strong> If the issue persists after checking the configuration, 
                try clearing your cache or contact the development team for assistance.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};


/**
 * Resolves the component that renders a Document, composed top-down:
 *
 *   <Entry kind={Document.entry} {...config} {...props}>   ← src/document/Entry.jsx
 *     <View />                    ← the app's `client/<entity>-<kind>.jsx`, if any
 *   </Entry>                      ← no view file → the entry renders its default
 *
 * The view module may `export const config = {...}` (chrome flags, list
 * options, `mapDocument`, ...): it is applied as props of the entry. A
 * Document without `entry` (e.g. the error view) mounts the view alone.
 */
export async function AppSourceLoader(Document) {
  const appSources = Object.entries(import.meta.glob([
    '/apps/**/modules/**/**/**/client/*.{jsx,tsx}',
    '../apps/core/modules/**/**/**/client/*.{jsx,tsx}',
  ])).reduce((acc, [path, module]) => {
    acc[path.split('/').pop().replace(/\.(jsx|tsx)$/, '')] = module;
    return acc;
  }, {});

  const kind = Document?.entry && entries[Document.entry] ? Document.entry : null;
  const viewImport = Document?.entryPoint && appSources[Document.entryPoint];
  const { default: View = null, config = null } = viewImport ? await viewImport() : {};

  if (!kind && !View) {
    return { default: () => <ErrorMessage Document={Document} /> };
  }

  if (!kind) return { default: View, config };

  // Children of the mount (e.g. the contact_form element's honeypot, captcha
  // and Send button) go to the view, which renders them inside its layout.
  const Mount = ({ children, ...props }) => (
    <Entry kind={kind} {...config} {...props}>
      {View ? <View>{children}</View> : children != null ? <DefaultView>{children}</DefaultView> : null}
    </Entry>
  );
  Mount.displayName = View ? `Entry(${kind}:${View.displayName || View.name || "View"})` : `Entry(${kind})`;

  return { default: Mount, config };
}

export const Loader = async (__META__, ENVIRONMENT) => {
  const Workspace = await WorkspaceLoader(__META__.name);

  if (!__META__.Document) {
    return { Workspace: Workspace.default, View: () => <ErrorMessage Document={__META__.Document} /> };
  }

  const Document = await AppSourceLoader(__META__.Document, ENVIRONMENT);
  await MetaComponentsLoader(__META__, ENVIRONMENT);

  return { Workspace: Workspace.default, View: Document.default };
}

async function __loader__(source) {
  return new Promise((resolve) => {
    AppSourceLoader(source).then(module => {
      resolve(module);
    })
  });
}

function _Import(source) {
  return lazy(() => __loader__(source));
}

export function Entity({ name, action, entityName, fallback, inModal, ...props }) {
  const [model, setModel] = useState(null);
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    loopar.getMeta(name, action).then((meta) => {
      if (meta){
        setMeta(meta)
        setModel({ Component: _Import(meta), meta });
      }
    });
  }, []);

  const updateValue = (structure, Document) => {
    return structure.map((el) => {
      if (Object.keys(Document).includes(el.data?.name)) {
        const value = Document[el.data.name];

        el.data.value = value;
      }

      el.elements = updateValue(el.elements || [], Document);
      return el;
    });
  };

  useEffect(() => {
    if (model && model.Document && model.Document.data)
      model.Document.Entity.doc_structure = JSON.stringify(updateValue(JSON.parse(model.Document.Entity.doc_structure)), model.Document.data);
  }, [model])

  if(!meta) return null;

  if (model) {
    const { Component, meta } = model;
    return (
      <div className="space-y-4 p-2">
        <Component 
          {...props} 
          inModal={inModal} 
          Document={meta} 
          entityName={entityName}
          hasHeader={props.hasHeader || false}
          hasFooter={props.hasFooter || false}
          hasSidebar={props.hasSidebar || false}
          hasSubmiting={props.hasSubmiting || false}
        >
          {props.children}
        </Component>
      </div>
    )
  }

  return fallback || <Fallback />;
}