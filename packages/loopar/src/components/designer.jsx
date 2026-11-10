import { useMemo, useCallback } from "react";
import BaseInput from "@base-input";
import { Designer } from "./designer/base-designer";
import { useDesigner } from "@context/designer-context";
import { utils } from "@global";

function DesignerField({ field, node, data, designerMode }) {
  // Memoize so metaComponents keeps a stable reference; parsing on every render
  // produced a fresh object that re-triggered BaseDesigner's deep-equal sync.
  // `field.value` can be "" / null when the designer element is itself nested
  // inside a structure being designed (e.g. editing the "Form Builder" record,
  // whose doc_structure contains a `designer` element) — JSON.parse("") throws
  // "Unexpected end of JSON input" during SSR and the whole page 500s.
  const metaComponents = useMemo(() => utils.JSONparse(field.value, []), [field.value]);
  const handleChange = useCallback((value) => field.onChange(value), [field]);

  return (
    <Designer
      node={designerMode ? node + "_designer" : node}
      metaComponents={metaComponents}
      data={{
        ...data,
      }}
      onChange={handleChange}
    />
  );
}

export default function MetaDesigner(props) {
  const { renderInput, data } = BaseInput(props);
  const { designerMode } = useDesigner();
  const node = props.node || data.key;

  return renderInput((field) => (
    <DesignerField
      field={field}
      node={node}
      data={data}
      designerMode={designerMode}
    />
  ));
}

MetaDesigner.metaFields = () => BaseInput.metaFields();
