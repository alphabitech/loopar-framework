import { MetaComponent } from "@meta-component";
import { FormWrapper } from "@form-provider";
import { useTable } from "./TableContext"
import { useViewOptions } from "@loopar/document";
import { useMemo, useRef, useCallback, useEffect } from "react";
import { useWorkspace } from "@workspace/workspace-provider";

export function TableSearch(props){
  const {Document, baseColumns, docRef} = useTable();
  const { hiddenSearchFields } = useViewOptions();
  const {award} = useWorkspace()
  const formRef = useRef(null);
  const debounceTimer = useRef(null);

  const lastSent = useRef(null);
  // Fields fixed by the view (e.g. the module on a module page): never shown nor sent.
  const hiddenFields = hiddenSearchFields || [];

  const searchFields = useMemo(() => {
    return baseColumns().filter(col => fieldIsWritable(col) &&
      [INPUT, TEXTAREA, SELECT, CHECKBOX, SWITCH].includes(col.element) &&
      (col.data.searchable || col.data.name === "name") &&
      !hiddenFields.includes(col.data.name)
    );
  }, [baseColumns, hiddenFields]);

  // Search values as they travel in the URL: strings, "1" for a checked box, empties dropped.
  const toUrlValues = useCallback((values = {}) => {
    const out = {};
    for (const col of searchFields) {
      const name = col.data.name;
      const v = values[name];
      if (v === true || v === 1) out[name] = "1";
      else if (v != null && v !== false && v !== "" && v !== 0 && String(v).trim() !== "") out[name] = String(v);
    }
    return out;
  }, [searchFields]);

  const saveData = useCallback((timer) => {
    const values = formRef.current.getValues();
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    
    debounceTimer.current = setTimeout(() => {
      // Every search field is sent (empty → removed from the URL).
      const urlValues = toUrlValues(values);
      const key = JSON.stringify(urlValues);
      // Some inputs report a change when they mount: nothing to search if the
      // form still says what the URL says.
      if (key === incomingRef.current) return;
      lastSent.current = key;
      const all = Object.fromEntries(
        searchFields.map(c => c.data.name).map(n => [n, urlValues[n] ?? null])
      );
      props.onChange(all);
    }, timer);
  }, [toUrlValues, searchFields, props.onChange]);

  const searchData = Document && Document.q && typeof Document.q == "object" ? Document.q : {};
  const incoming = JSON.stringify(toUrlValues(searchData));
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;

  // The URL changed from outside the form (back/forward, a shared link, the
  // command palette): show its filters. Our own echo is skipped so a response
  // never overwrites what the user kept typing meanwhile.
  useEffect(() => {
    const form = formRef.current;
    if (!form || incoming === lastSent.current) return;
    if (JSON.stringify(toUrlValues(form.getValues())) === incoming) return;

    const next = {};
    for (const col of searchFields) {
      const name = col.data.name;
      const v = searchData[name];
      next[name] = [CHECKBOX, SWITCH].includes(col.element) ? ([1, "1", true].includes(v) ? 1 : 0) : (v ?? "");
    }
    form.reset(next);
  }, [incoming]);

  if(!award(Document?.Entity?.name, "search")) return false;

  return (
    <FormWrapper __DATA__={searchData} className="w-full" formRef={formRef}>
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 items-center">
        {searchFields.length > 0 && searchFields.map((c) => {
          if (c.data.name !== "selector_all") {
            if (fieldIsWritable(c)) {
              const data = {
                ...{
                  simpleInput: false,
                  withoutLabel: true,
                },
                ...c.data,
                required: 0,
              };

              data.name = c.data.name;
              data.label = c.data.label;
              data.size = "sm";
              
              return (
                <MetaComponent
                  key={c.data.name}
                  component={c.element}
                  render={Component => (
                    <Component
                      data={{
                        ...data,
                      }}
                      dontHaveLabel={true}
                      onChange={(e) => {
                        saveData([SELECT, SWITCH, CHECKBOX].includes(c.element) || e.target.value == "" ? 0: 300)
                      }}
                    />
                  )}
                />
              )
            }
          }
        })}
      </div>
    </FormWrapper>
  );
}