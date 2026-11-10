import { useRef, useMemo, useState, useContext } from 'react';
import { __META_COMPONENTS__ } from "@loopar/components-loader";
import loopar from "loopar";
import { elementsDict } from "@global/element-definition";
import {MetaComponent} from "@@meta/meta-component";
import { Separator } from "@cn/components/ui/separator";
import { Input } from "@cn/components/ui/input";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getMetaFields } from "@@tools/meta-fields";
import { DesignerContext, useDesigner } from "@context/designer-context";
import { FormWrapper } from "@form-provider";
import { isEqual } from 'es-toolkit/predicate';
import { __ } from "@global/i18n";
import { ElementLanguages } from "./element-languages";
import { useDocument } from "@loopar/document";
import { getNodeKey } from "@global/prune-doc-structure";
import { BaseFormContext } from "@form-context";
import { ElementEditorContext } from "@context/element-editor-context";
import { evaluateCondition } from "@global/condition";

/**
 * The editor's fields are named `elementKey + prop`; conditions and pickers
 * written against sibling props (`parent: "options"`, `display_on`) read the
 * same values without the prefix. Control and registration stay prefixed.
 */
function UnprefixedValues({ prefix, children }) {
  const ctx = useContext(BaseFormContext);
  const value = useMemo(() => {
    if (!ctx) return ctx;
    const values = Object.fromEntries(Object.entries(ctx.values || {}).map(([key, v]) =>
      [key.startsWith(prefix) ? key.slice(prefix.length) : key, v]));
    return { ...ctx, values };
  }, [ctx, prefix]);
  return <BaseFormContext.Provider value={value}>{children}</BaseFormContext.Provider>;
}

/** Hidden (never unmounted, its value is kept) while `displayOn` is false. */
function EditorField({ displayOn, className = "", children }) {
  const values = useContext(BaseFormContext)?.values || {};
  const visible = !displayOn || evaluateCondition(displayOn, values);
  return <div className={visible ? className : "hidden"}>{children}</div>;
}

function mergeGroups(...arrays) {
  const groupMap = new Map();
  const flattenedArrays = arrays.flat();

  flattenedArrays.forEach(group => {
    const groupName = group.group;

    if (!groupMap.has(groupName)) {
      groupMap.set(groupName, { ...group, elements: { ...group.elements } });
    } else {
      const existingGroup = groupMap.get(groupName);
      const mergedElements = {
        ...existingGroup.elements,
        ...group.elements,
      };
      groupMap.set(groupName, { ...existingGroup, elements: mergedElements });
    }
  });
  
  const allElements = new Set();

  flattenedArrays.forEach(group => {
    Object.keys(group.elements).forEach(elementKey => {
      if (allElements.has(elementKey)) {
        groupMap.forEach((mappedGroup, groupName) => {
          if (groupName !== group.group && mappedGroup.elements[elementKey]) {
            delete mappedGroup.elements[elementKey];
          }
        });
      } else {
        allElements.add(elementKey);
      }
    });
  });

  return Array.from(groupMap.values());
}

// Elements whose value can't sensibly have a default (secrets, child tables,
// structure, uploads, identity).
const NO_DEFAULT_VALUE = new Set(["designer", "password", "form_table", "id", "file_input", "image_input", "metadata", "tailwind", "slot"]);
const DEFAULT_VALUE_DROPPED_KEYS = new Set([
  "readonly", "formula", "disabled", "hidden", "display_on", "required", "required_on", "unique",
  "write_policy", "write_roles", "protected_change", "default_value", "value", "description",
  "in_list_view", "searchable", "print_hide", "translatable", "internal", "required_on_website",
]);

const ACTIVE_SECTION_KEY = "element-editor-active-section";
const NONE = "__none__";

const readActiveSection = () => {
  try {
    return localStorage.getItem(ACTIVE_SECTION_KEY);
  } catch (e) {
    return null;
  }
};

export function ElementEditor() {
  const { updateElement, updatingElement, getElementPath, handleEditElement, metaTree } = useDesigner();
  // Fields scoped to some document types (data.contexts) show only there.
  const { entity: documentType } = useDocument();

  if (!updatingElement) return null;

  const elementName = updatingElement.element;
  // Root → selected chain; ancestors are clickable to select the container.
  const elementPath = getElementPath ? getElementPath(getNodeKey(updatingElement)) : [];

  const data = useMemo(() => {
    return {...updatingElement.data,};
  }, [updatingElement.data, elementName]);

  const elementKey = updatingElement.node ?? data.key;

  const Element = __META_COMPONENTS__[elementName]?.default || {};

  typeof data.options === 'object' && (data.options = JSON.stringify(data.options));

  const dontHaveMetaElements = Element.dontHaveMetaElements || []

  const metaFields = useMemo(() => {
    const genericMetaFields = getMetaFields(updatingElement);
    const selfMetaFields = Element.metaFields && Element.metaFields() || [];
    return mergeGroups(genericMetaFields, ...selfMetaFields)
      .filter(({ elements }) => Object.keys(elements || {}).length > 0);
  }, [data, Element]);

  const metaFieldsData = useMemo(() => {
    return metaFields.map(({ group, elements: allElements }) => {
      const elements = Object.fromEntries(Object.entries(allElements).filter(([, props]) =>
        !Array.isArray(props?.data?.contexts) || props.data.contexts.includes(documentType)
      ));
      if (group === 'form' && elementsDict[elementName]?.def?.isWritable && !NO_DEFAULT_VALUE.has(elementName)) {
        elements['divider_default'] = (
          <Separator className="my-3" />
        );

        // The default is edited with the field's own element, but as a plain
        // editable input: none of the field's behavior flags (read-only,
        // formula, conditions, write policy…) may lock or hide it here.
        const presentation = Object.fromEntries(
          Object.entries(data).filter(([key]) => !DEFAULT_VALUE_DROPPED_KEYS.has(key))
        );
        elements['default_value'] = {
          element: elementName,
          key: elementKey + "_default",
          data: {
            ...presentation,
            label: "Default",
            description: "Value a new record starts with.",
          }
        };
      }
  
      return { group, elements };
    });
  }, [metaFields, elementName, data, documentType]);

  const __FORM_FIELDS__ = useMemo(() => {
    const formFields = {};
    metaFieldsData.forEach(({ group, elements }) => {
      Object.entries(elements).forEach(([field, props]) => {
        if (dontHaveMetaElements.includes(field)) return null;
        if (!props.element) return props;
        // Same "missing" semantics as applyMetaDefaults (@@tools/meta-defaults):
        // only undefined/null/"" fall back to the default, so explicit falsy
        // values (false, 0) set by the user are not overwritten in the form.
        const value = data[field];
        formFields[elementKey + field] =
          (value === undefined || value === null || value === "")
            ? props?.data?.default_value
            : value;
      });
    });

    return formFields;
  }, [metaFieldsData, dontHaveMetaElements, data, elementKey]);

  const prevData = useRef(__FORM_FIELDS__);
  const editingKey = useRef(elementKey);

  if (editingKey.current !== elementKey) {
    editingKey.current = elementKey;
    prevData.current = __FORM_FIELDS__;
  }

  const saveData = (_data) => {
    if(!prevData.current || isEqual(prevData.current, _data)) return;

    prevData.current = { ..._data };

    function cleanObject(obj) {
      return Object.fromEntries(
        // Drop only truly empty values; false/0 are legitimate user values
        // (the old `value ?? false` filter made switches impossible to turn off).
        Object.entries({...obj}).filter(([_, value]) => value !== undefined && value !== null && value !== "")
      );
    }

    function cleanKey(obj) {
      return Object.fromEntries(
        Object.entries({...obj}).map(([key, value]) => [key.replace(elementKey, ""), value])
      );
    }

    const newData = cleanKey(_data);
    //newData.key = elementKey;
    newData.value = data.value;

    updateElement(elementKey, cleanObject(newData), false, true);
  };
  
  const formRef = useRef(null);

  const [search, setSearch] = useState("");
  const [activeSection, setActiveSection] = useState(readActiveSection);
  const query = search.trim().toLowerCase();

  const toggleGroup = (group) => {
    setActiveSection(prev => {
      const next = prev === group ? NONE : group;
      try { localStorage.setItem(ACTIVE_SECTION_KEY, next); } catch (e) {}
      return next;
    });
  };

  const groupNames = metaFieldsData.map(g => g.group);
  const openGroup =
    activeSection === NONE ? null :
    groupNames.includes(activeSection) ? activeSection :
    groupNames[0];

  const fieldMatches = (field, props) => {
    if (!query) return true;
    const label = String(props?.data?.label || "");
    return field.replaceAll("_", " ").toLowerCase().includes(query) ||
      label.toLowerCase().includes(query);
  };

  const editorContext = useMemo(() => ({ metaTree, elementKey, element: elementName }), [metaTree, elementKey, elementName]);

  return (
    <ElementEditorContext.Provider value={editorContext}>
    <DesignerContext.Provider
      value={{}}
    >
      <FormWrapper
        key={`${elementKey}${updatingElement.__version__ ?? ""}`}
        __DATA__={__FORM_FIELDS__}
        onChange={saveData}
        formRef={formRef}
      >
        <UnprefixedValues prefix={elementKey}>
        <div className="flex flex-col">
          <div className="sticky top-0 z-10 bg-background dark:bg-background-dark p-2 pb-1">
            <div className="flex items-baseline gap-2 min-w-0 px-1 pb-1.5">
              <span className="text-sm font-semibold truncate">{loopar.utils.Capitalize(elementName)}</span>
              <span className="text-muted-foreground text-xs truncate">{elementKey}</span>
              <span className="ml-auto shrink-0">
                <ElementLanguages elementKey={elementKey} element={elementName} data={updatingElement.data} />
              </span>
            </div>
            {elementPath.length > 1 && (
              <nav
                aria-label={__("Element path")}
                className="flex flex-wrap items-center gap-y-0.5 px-1 pb-1.5 text-xs text-muted-foreground"
              >
                {elementPath.map((step, i) => {
                  const last = i === elementPath.length - 1;
                  const label = loopar.utils.Capitalize(String(step.element || "").replaceAll("_", " "));
                  return (
                    <span key={step.key} className="flex items-center">
                      {i > 0 && <ChevronRight className="h-3 w-3 mx-0.5 shrink-0 opacity-60" />}
                      {last ? (
                        <span className="font-medium text-foreground">{label}</span>
                      ) : (
                        <button
                          type="button"
                          className="rounded px-0.5 hover:text-foreground hover:bg-muted transition-colors"
                          onClick={() => handleEditElement(step.key)}
                        >
                          {label}
                        </button>
                      )}
                    </span>
                  );
                })}
              </nav>
            )}
            <Input
              type="search"
              placeholder={__("Search properties...")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {metaFieldsData.map(({ group, elements }, index) => {
            const fields = Object.entries(elements)
              .filter(([field]) => !dontHaveMetaElements.includes(field));
            const matches = query
              ? fields.filter(([field, props]) => props.element && fieldMatches(field, props)).length
              : fields.length;

            const isCollapsed = !query && openGroup !== group;

            return (
              <div
                key={`${elementKey}-${group}-section`}
                className={query && matches === 0 ? "hidden" : "pb-2"}
              >
                <div className="sticky top-[78px] z-[5] bg-background dark:bg-background-dark px-1 pb-1">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between rounded-md bg-secondary hover:bg-muted px-3 py-2 text-left transition-colors"
                    onClick={() => toggleGroup(group)}
                  >
                    <span className="text-sm font-semibold uppercase tracking-wider">{loopar.utils.Capitalize(group)}</span>
                    <ChevronDown
                      className={`h-4 w-4 text-muted-foreground transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                    />
                  </button>
                </div>
                <div className={`flex-col pl-2 ${isCollapsed ? "hidden" : "flex"}`}>
                  <div className='w-full border-l-3 p-2 pt-3 border-secondary flex flex-col gap-4'>
                    {fields.map(([field, props]) => {
                      if (!props.element) {
                        return (
                          <div
                            key={`${elementKey}-${group}-${field}`}
                            className={query ? "hidden" : ""}
                          >{props}</div>
                        );
                      }

                      return (
                        <EditorField
                          key={`${elementKey}-${group}-${field}`}
                          displayOn={props.data?.display_on}
                          className={query && !fieldMatches(field, props) ? "hidden" : ""}
                        >
                          <MetaComponent
                            component={props.element}
                            render={Component => (
                              <Component
                                data={{
                                  ...props.data,
                                  name: elementKey + field,
                                  label: props.data?.label || loopar.utils.Capitalize(field.replaceAll("_", " ")),
                                }}
                              />
                            )}
                          />
                        </EditorField>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        </UnprefixedValues>
      </FormWrapper>
    </DesignerContext.Provider>
    </ElementEditorContext.Provider>
  );
};
