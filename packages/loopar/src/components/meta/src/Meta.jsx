import React, { useMemo, memo } from "react";
import { elementsDict as baseElementsDict } from "@global/element-definition";
import { useMetaModule } from "@loopar/components-loader";
import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";
import { useDocument } from "@loopar/document";
import { useFieldMeta } from "@loopar/document";
import { useFormValues } from "@form-context";
import { extractFieldNames, evaluateCondition, useBuildMetaProps } from "./meta";
import { MetaRender } from "./MetaRender";
import { DesignElement } from "./DesignElement";
import { useElementData } from "../../designer/element-store.js";
import { getNodeKey } from "@global/prune-doc-structure";
import { applyMetaDefaults } from "@@tools/meta-defaults";

export const Meta = memo(function Meta(props) {
  const { meta, parent, parentKey, className } = props;

  if(meta && meta.$$typeof === Symbol.for("react.transitional.element")){
    return meta;
  }

  const liveData = useElementData(getNodeKey(meta), meta?.data);
  const liveMeta = useMemo(
    () => (liveData && liveData !== meta?.data ? { ...meta, data: liveData } : meta),
    [meta, liveData]
  );

  const designer = useDesigner();
  const { docRef, Document } = useDocument();
  // Live values for `display_on`: the form when inside one, the document data otherwise.
  const formValues = useFormValues() ?? Document?.data ?? {};
  const isDesigner = designer.designerMode// && designer.designerModeType != "preview";
  const metaProps = useBuildMetaProps({ meta: liveMeta, parent, isDesigner });
  // Runtime overrides of this field (setFieldDf / on): reactive, per field.
  const fieldMeta = useFieldMeta(docRef?.fields, metaProps.data?.name);
  
  const def = baseElementsDict[meta.element]?.def || {};

  const runtimeData = fieldMeta?.data;
  const displayOn = runtimeData?.display_on ?? metaProps.data?.display_on;
  const hiddenFlag = runtimeData?.hidden ?? metaProps.data?.hidden;

  const display = useMemo(() => {
    if (displayOn) {
      const fields = extractFieldNames(displayOn);
      const values = fields.reduce((acc, field) => {
        acc[field] = formValues[field];
        return acc;
      }, {});
      return evaluateCondition(displayOn, values);
    }
    return ![true, "true", "1", 1].includes(hiddenFlag);
  }, [displayOn, hiddenFlag, formValues]);

  // Suspends until the element's module is loaded (the <Suspense> around each
  // Meta in MetaComponentBase scopes the wait). Designer-only elements load
  // only in the designer.
  const metaModule = useMetaModule(meta.element, isDesigner || def.designerOnly !== true);
  const Comp = metaModule?.default || metaModule;

  if (Comp || [HTML_BLOCK, MARKDOWN, SEO].includes(meta.element)) {
    // Hydrate metaFields defaults here — the common point for SSR, the public
    // page and the designer — so the base render no longer depends on the
    // element editor mounting to see values like feature-card's default icon.
    //
    // `metaProps` is memoized (useBuildMetaProps) — never mutate it. It used to
    // be mutated here (data, className, runtime overrides), so each render
    // started from the previous one's leftovers: a `setFieldDf(name, "disabled"
    // | "hidden", …)` showed up one render late, and the wrapper below read the
    // pre-override data (a button could look disabled while being clickable).
    // Each render now builds its own props: defaults, then runtime overrides.
    const baseData = applyMetaDefaults(Comp, metaProps.data || {});
    const data = fieldMeta ? { ...baseData, ...(fieldMeta.data || {}) } : baseData;

    const renderProps = {
      ...metaProps,
      ...(fieldMeta || {}),
      data,
      className: cn(
        "relative",
        def.designerClasses,
        metaProps.className,
        meta.className,
        className,
        (!isDesigner || !designer.designing) && 'space-y-4 gap-4',
        (designer.designing && def.droppable) && "pt-4 overflow-y-auto",
        data?.class
      ),
    };

    if (isDesigner && Comp && data.wrapper !== true) {
      return (
        <DesignElement
          Comp={Comp}
          element={renderProps}
          parent={parent}
          parentKey={parentKey}
          def={def}
        />
      )
    } else if (!data.hidden && display) {
      const disabled = data.disabled;
      const Wrapper = disabled ? "div" : React.Fragment;
      const fragmentProps = disabled ? { className: " opacity-40" } : {};

      return (
        <Wrapper {...fragmentProps}>
          <MetaRender
            Comp={Comp}
            meta={meta}
            parent={parent}
            parentKey={parentKey}
            docRef={docRef}
            data={data}
            threshold={0.1}
            metaProps={renderProps}
          />
        </Wrapper>
      )
    }
  } else {
    return null;
  }
});