import { Suspense, useRef } from "react";
import { useMetaModule } from "@loopar/components-loader";
import { useDesigner } from "@context/designer-context";
import { DesignElement } from "./src/DesignElement.jsx";
import { Meta } from "./src/Meta.jsx"
import { getNodeKey } from "@global/prune-doc-structure";

import { elementsDict as baseElementsDict } from "@global/element-definition";

export default function MetaComponentBase ({ elements=[], parent, className, parentKey}) {
  const isDesigner = useDesigner().designerMode;

  return elements.map((meta, index) => {
    if(meta && meta.$$typeof === Symbol.for("react.transitional.element")){
      return meta;
    }

    const nodeKey = getNodeKey(meta);
    const hasKey = nodeKey != null && String(nodeKey).length > 0;
    const key = hasKey
      ? `${String(nodeKey)}${isDesigner ? "-d" : ""}`
      : `${String(parentKey ?? "root")}${isDesigner ? "d" : ""}-${index}`;

    // One boundary per element: SSR waits for its module, hydration keeps
    // its server HTML until it loads, client renders fill it in when ready.
    return (
      <Suspense key={key} fallback={null}>
        <Meta
          meta={meta}
          parent={parent}
          className={className}
          parentKey={parentKey}
        />
      </Suspense>
    )
  });
}

export const MetaComponent = (props) => (
  <Suspense fallback={null}>
    <MetaComponentLoaded {...props} />
  </Suspense>
);

function MetaComponentLoaded({ component = "div", render, ...props }) {
  const isDesigner = useDesigner().designerMode;
  const ref = useRef(null);
  const def = baseElementsDict[component]?.def || {};

  const metaModule = useMetaModule(component, isDesigner || def.designerOnly !== true);
  const Comp = metaModule?.default || metaModule;

  if(!Comp) return null;

  if (isDesigner) {
    return (
      <DesignElement Comp={Comp} element={{ ...props, ...{ element: component } }}>
        {render && render(Comp, ref)}
      </DesignElement>
    )
  }

  return render(Comp, ref);
}