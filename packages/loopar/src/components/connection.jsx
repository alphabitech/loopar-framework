import BaseInput from "@base-input";
import { FormLabel } from "./input/index.js";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import loopar from "loopar";
import { Select } from "./select/base-select.jsx";
import { FormDescription } from "@cn/components/ui/form";
import { Button } from "@cn/components/ui/button";
import { PlusIcon } from "@radix-ui/react-icons";
import { useWorkspace } from "@workspace/workspace-provider";
import { EntryModal } from "@app/entry-modal";
import { makeUrl } from "./link.jsx";
import { useDocument } from "@loopar/document";
import { useFormValues } from "@form-context";
import { multipleValues } from "@global/element-definition";
import { ChoiceList } from "./select/choice-list.jsx";
import { SelectedChips, multipleMetaFields } from "./select/selected-chips.jsx";
import { entityPicker, entityFieldPicker, formFieldPicker } from "./base/entity-pickers.js";

const PAGE_LIMIT = 20;
const CHECKBOX_LIMIT = 100;

/** "Title - Subtitle" from a record and the entity's title fields. */
const titleOf = (row, titleFields) => {
  const parts = (titleFields || []).map((f) => row?.[f]).filter((v) => v !== null && v !== undefined && v !== "");
  return parts.length ? parts.join(" - ") : row?.name;
};

/**
 * A connection to records of another entity (`options` = entity name):
 * searched on the server as you type, with a + button to create one.
 *  - group_by: a field of that entity; records are shown under its values.
 *  - parent / parent_filter: cascade — only records whose `parent_filter`
 *    field equals the value of the form's `parent` field.
 *  - multiple: several records (JSON list), as chips or checkboxes.
 */
export default function MetaConnection(props) {
  const { renderInput, data } = BaseInput(props);
  const { award } = useWorkspace();
  const { Document: ownerDocument } = useDocument();
  const sourceEntity = ownerDocument?.Entity?.name;
  const formValues = useFormValues() ?? {};
  const linkTitles = ownerDocument?.linkTitles;

  const entity = String(data.options || "").split(/\r?\n/)[0].trim();
  const multiple = loopar.utils.trueValue(data.multiple);
  const checkboxes = multiple && data.display === "checkboxes";
  const max = parseInt(data.max_items, 10) || 0;
  const parentValue = data.parent ? formValues[data.parent] : undefined;
  const waitingParent = !!data.parent && (parentValue === undefined || parentValue === null || parentValue === "");

  const [rows, setRows] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [known, setKnown] = useState({}); // value → label of records seen
  // Directories (virtual entities) have no records to create.
  const [creatable, setCreatable] = useState(entity !== "Entity Directory"); // false: a directory (no records to create)

  const abortRef = useRef(null);
  const paginationRef = useRef({ page: 1, limit: PAGE_LIMIT, pages: 1 });
  const queryRef = useRef("");
  const fieldRef = useRef(null);

  const labelOf = useCallback(
    (value) => known[value] ?? linkTitles?.[entity]?.[value] ?? (!multiple && value === fieldRef.current?.value ? data.value_descriptive : null) ?? value,
    [known, linkTitles, entity, multiple, data.value_descriptive]
  );

  const getServerData = useCallback((q = "", page = 1, append = false, limit = PAGE_LIMIT) => {
    if (!entity || data.disabled) return Promise.resolve([]);
    if (waitingParent) {
      setRows([]);
      return Promise.resolve([]);
    }
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setIsLoading(true);
    setError(null);

    return new Promise((resolve) => {
      loopar.call(entity, "search", {
        query: {
          q,
          page,
          limit,
          // The server compares `parent_filter` (or the field it infers from
          // how the parent connects to this entity) with the parent value.
          ...(data.parent ? {
            parent_field: data.parent,
            filter_value: parentValue,
            ...(data.parent_filter ? { filter_field: data.parent_filter } : {}),
            ...(sourceEntity ? { source_entity: sourceEntity } : {}),
          } : {}),
          ...(data.group_by ? { group_by: data.group_by } : {}),
          ...(data.filters ? { filters: data.filters } : {}),
        },
        signal: abortRef.current.signal,
        freeze: false,
        success: (r) => {
          const prepared = (r.rows || []).map((row) => ({
            value: row.name,
            label: titleOf(row, r.title_fields),
            formattedValue: row.formattedValue,
            group: data.group_by ? (row[data.group_by] ?? "—") : null,
          }));
          if (r.creatable === false) setCreatable(false);
          if (r.pagination) paginationRef.current = { ...paginationRef.current, ...r.pagination, page };
          setKnown((prev) => ({ ...prev, ...Object.fromEntries(prepared.map((o) => [o.value, o.label])) }));
          setRows((prev) => append && page > 1
            ? [...new Map([...prev, ...prepared].map((o) => [o.value, o])).values()]
            : prepared);
          setIsLoading(false);
          resolve(prepared);
        },
        error: (err) => {
          if (err?.name !== "AbortError") {
            setError(err?.message || "Error loading data");
            setIsLoading(false);
          }
          resolve([]);
        },
      });
    });
  }, [entity, data.disabled, data.group_by, data.parent, data.parent_filter, data.filters, sourceEntity, parentValue, waitingParent]);

  const timeoutRef = useRef(null);
  const search = useCallback((target, delay = true) => {
    const q = target?.target?.value || "";
    queryRef.current = q;
    clearTimeout(timeoutRef.current);
    if (!delay) return getServerData(q, 1, false);
    return new Promise((resolve) => {
      timeoutRef.current = setTimeout(() => getServerData(q, 1, false).then(resolve), 200);
    });
  }, [getServerData]);

  const loadMore = useCallback(() => {
    const { page, pages } = paginationRef.current;
    if (isLoading || page >= pages) return Promise.resolve();
    return getServerData(queryRef.current, page + 1, true);
  }, [isLoading, getServerData]);

  // Checkboxes show the records up front (and again when the parent changes).
  useEffect(() => {
    if (checkboxes) getServerData("", 1, false, CHECKBOX_LIMIT);
  }, [checkboxes, getServerData]);

  // A parent change clears the values chosen for the previous parent.
  const prevParent = useRef(parentValue);
  useEffect(() => {
    if (!data.parent || prevParent.current === parentValue) return;
    prevParent.current = parentValue;
    const field = fieldRef.current;
    if (!field) return;
    if (multiple) {
      if (multipleValues(field.value).length) field.onChange(JSON.stringify([]));
    } else if (field.value) {
      field.onChange(null);
    }
  }, [parentValue, data.parent, multiple]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const pagination = useMemo(() => ({
    ...paginationRef.current,
    hasMore: paginationRef.current.page < paginationRef.current.pages,
  }), [rows]);

  const canCreate = useMemo(() => {
    if (!entity || data.disabled || !creatable) return false;
    return !!award?.(entity.toLowerCase().replaceAll(" ", ""), "create", false);
  }, [entity, data.disabled, creatable, award]);

  const handleCreated = useCallback((name) => {
    setCreateOpen(false);
    if (!name) return;
    setKnown((prev) => ({ ...prev, [name]: prev[name] ?? name }));
    const field = fieldRef.current;
    if (multiple) field?.onChange(JSON.stringify([...new Set([...multipleValues(field?.value), name])]));
    else field?.onChange(name);
    getServerData("", 1, false).catch(() => {});
  }, [multiple, getServerData]);

  return renderInput((field) => {
    fieldRef.current = field;
    const values = multiple ? multipleValues(field.value) : [];
    const setValues = (next) => field.onChange(JSON.stringify(next));
    const locked = data.disabled || (multiple && max > 0 && values.length >= max);

    return (
      <>
        <FormLabel {...props} field={field} />
        {checkboxes ? (
          <ChoiceList
            name={field.name}
            options={rows}
            values={values}
            onChange={setValues}
            disabled={loopar.utils.trueValue(data.disabled) || waitingParent}
            max={max}
          />
        ) : (
          <div className="flex w-full items-start gap-1">
            <div className="min-w-0 flex-1">
              {multiple && (
                <SelectedChips
                  values={values}
                  labelOf={labelOf}
                  disabled={data.disabled}
                  onRemove={(v) => setValues(values.filter((x) => x !== v))}
                />
              )}
              <Select
                field={field}
                options={multiple ? rows.filter((r) => !values.includes(String(r.value))) : rows}
                search={search}
                loadMore={loadMore}
                pagination={pagination}
                data={locked || waitingParent ? { ...data, disabled: 1 } : data}
                onSelect={multiple
                  ? (v) => { if (v !== undefined && v !== null && v !== "") setValues([...new Set([...values, String(v)])]); }
                  : field.onChange}
                selected={multiple || !field.value ? null : { value: field.value, label: labelOf(field.value), formattedValue: props.formattedValue }}
                isLoading={isLoading}
                error={error}
                isLocal={false}
                renderOption={props.renderOption}
                model={entity}
              />
            </div>
            {canCreate && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="shrink-0"
                aria-label={`Create ${entity}`}
                title={`Create ${entity}`}
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
        {createOpen && (
          <EntryModal
            initialPath={makeUrl(`${entity}/create`)}
            onClose={() => setCreateOpen(false)}
            onSaved={handleCreated}
          />
        )}
        {(data.description && props.simpleInput !== true) && (
          <FormDescription>{data.description}</FormDescription>
        )}
      </>
    );
  });
}

MetaConnection.metaFields = () => [
  ...BaseInput.metaFields(),
  [
    {
      group: "form",
      elements: {
        options: entityPicker({ label: "Entity", description: "Entity whose records are offered." }),
        group_by: entityFieldPicker("options", { label: "Group by", description: "Field of that entity; records show under its values (e.g. city)." }, "scalar"),
        parent: formFieldPicker({ label: "Parent field", description: "Field of this form the choices depend on (e.g. state)." }),
        parent_filter: entityFieldPicker("options", {
          label: "Filter field",
          description: "Field of the connected entity compared with the parent value. Empty: the field that connects to the parent's entity (or one named like the parent).",
        }, "scalar"),
        filters: {
          element: TEXTAREA,
          data: { label: "Filters", description: "Only records matching every line: field = value (e.g. status = Active)." },
        },
        ...multipleMetaFields(),
      },
    },
  ],
];
