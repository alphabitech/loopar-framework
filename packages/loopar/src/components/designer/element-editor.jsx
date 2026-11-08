import { useRef, useMemo, useState } from 'react';
import { __META_COMPONENTS__ } from "@loopar/components-loader";
import loopar from "loopar";
import { elementsDict } from "@global/element-definition";
import {MetaComponent} from "@@meta/meta-component";
import { Separator } from "@cn/components/ui/separator";
import { Input } from "@cn/components/ui/input";
import { ChevronDown } from "lucide-react";
import { getMetaFields } from "@@tools/meta-fields";
import { DesignerContext, useDesigner } from "@context/designer-context";
import { FormWrapper } from "@form-provider";
import { isEqual } from 'es-toolkit/predicate';
import { __ } from "@global/i18n";
import { ElementLanguages } from "./element-languages";

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
  const { updateElement, updatingElement } = useDesigner();

  if (!updatingElement) return null;

  const elementName = updatingElement.element;

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
    return mergeGroups(genericMetaFields, ...selfMetaFields);
  }, [data, Element]);

  const metaFieldsData = useMemo(() => {
    return metaFields.map(({ group, elements }) => {
      if (group === 'form' && elementsDict[elementName]?.def?.isWritable && ["designer", "fragment"].includes(elementName) === false) {
        elements['divider_default'] = (
          <Separator className="my-3" />
        );
  
        elements['default_value'] = {
          element: elementName,
          key: elementKey + "_default",
          data: {
            ...data,
            label: "Default",
            hidden: 0,
            required: 0,
          }
        };
      }
  
      return { group, elements };
    });
  }, [metaFields, elementName, data]);

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

  return (
    <DesignerContext.Provider
      value={{}}
    >
      <FormWrapper
        key={`${elementKey}${updatingElement.__version__ ?? ""}`}
        __DATA__={__FORM_FIELDS__}
        onChange={saveData}
        formRef={formRef}
      >
        <div className="flex flex-col">
          <div className="sticky top-0 z-10 bg-background dark:bg-background-dark p-2 pb-1">
            <div className="flex items-baseline gap-2 min-w-0 px-1 pb-1.5">
              <span className="text-sm font-semibold truncate">{loopar.utils.Capitalize(elementName)}</span>
              <span className="text-muted-foreground text-xs truncate">{elementKey}</span>
              <span className="ml-auto shrink-0">
                <ElementLanguages elementKey={elementKey} element={elementName} data={updatingElement.data} />
              </span>
            </div>
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
                <div className={`flex-col gap-2 pl-2 ${isCollapsed ? "hidden" : "flex"}`}>
                  <div className='w-full border-l-3 p-2 pt-3 border-secondary'>
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
                        <div
                          key={`${elementKey}-${group}-${field}`}
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
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </FormWrapper>
    </DesignerContext.Provider>
  );
};
