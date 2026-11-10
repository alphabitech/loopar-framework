import BaseInput from "@base-input";
import { FormLabel } from "./input/index.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import loopar from "loopar";
import { Select } from "./select/base-select.jsx";
import { FormDescription } from "@cn/components/ui/form";
import { useFormValues } from "@form-context";
import { multipleValues } from "@global/element-definition";
import { parseStaticOptions, optionsForParent } from "./select/options.js";
import { ChoiceList } from "./select/choice-list.jsx";
import { SelectedChips, multipleMetaFields } from "./select/selected-chips.jsx";
import { formFieldPicker } from "./base/entity-pickers.js";

/**
 * Choice from a fixed list (`options`: value / value:Label per line, `# Group`
 * headings). Records of another entity are a `connection`.
 * With `parent`, only the group whose value matches the parent field shows.
 */
export default function MetaSelect(props) {
  const { renderInput, data } = BaseInput(props);
  const formValues = useFormValues() ?? {};
  const multiple = loopar.utils.trueValue(data.multiple);
  const max = parseInt(data.max_items, 10) || 0;
  const parentValue = data.parent ? formValues[data.parent] : undefined;

  const allOptions = useMemo(() => parseStaticOptions(data.options), [data.options]);
  const options = useMemo(
    () => optionsForParent(allOptions, parentValue, !!data.parent),
    [allOptions, parentValue, data.parent]
  );

  const [rows, setRows] = useState(options);
  useEffect(() => setRows(options), [options]);

  const search = useCallback((target) => {
    const q = String(target?.target?.value || "").toLowerCase();
    const filtered = q ? options.filter((o) => `${o.value} ${o.label}`.toLowerCase().includes(q)) : options;
    setRows(filtered);
    return Promise.resolve(filtered);
  }, [options]);

  const labelOf = useCallback(
    (value) => allOptions.find((o) => String(o.value) === String(value))?.label ?? value,
    [allOptions]
  );

  // A parent change leaves out values that don't belong to its group.
  const fieldRef = useRef(null);
  const prevParent = useRef(parentValue);
  useEffect(() => {
    if (!data.parent || prevParent.current === parentValue) return;
    prevParent.current = parentValue;
    const field = fieldRef.current;
    if (!field) return;
    const allowed = new Set(options.map((o) => String(o.value)));
    if (multiple) {
      const values = multipleValues(field.value);
      const kept = values.filter((v) => allowed.has(v));
      if (kept.length !== values.length) field.onChange(JSON.stringify(kept));
    } else if (field.value && !allowed.has(String(field.value))) {
      field.onChange(null);
    }
  }, [parentValue, options, multiple, data.parent]);

  return renderInput((field) => {
    fieldRef.current = field;
    const values = multiple ? multipleValues(field.value) : [];
    const setValues = (next) => field.onChange(JSON.stringify(next));

    return (
      <>
        <FormLabel {...props} field={field} />
        {multiple && data.display === "checkboxes" ? (
          <ChoiceList
            name={field.name}
            options={options}
            values={values}
            onChange={setValues}
            disabled={loopar.utils.trueValue(data.disabled)}
            max={max}
          />
        ) : (
          <div className="min-w-0">
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
              data={multiple && max > 0 && values.length >= max ? { ...data, disabled: 1 } : data}
              onSelect={multiple
                ? (v) => { if (v !== undefined && v !== null && v !== "") setValues([...new Set([...values, String(v)])]); }
                : field.onChange}
              selected={multiple || !field.value ? null : { value: field.value, label: labelOf(field.value) }}
              isLocal={true}
              renderOption={props.renderOption}
            />
          </div>
        )}
        {(data.description && props.simpleInput !== true) && (
          <FormDescription>{data.description}</FormDescription>
        )}
      </>
    );
  });
}

MetaSelect.metaFields = () => [
  ...BaseInput.metaFields(),
  [
    {
      group: "form",
      elements: {
        options: {
          element: TEXTAREA,
          data: {
            description: "One option per line: value or value:Label. Lines starting with # open a group: # Label or # value:Label.",
          },
        },
        parent: {
          ...formFieldPicker(),
          data: {
            label: "Parent field",
            description: "Name of another field of the form. Only the group whose value matches it is offered (e.g. # HN:Honduras → its cities when the parent is HN).",
          },
        },
        ...multipleMetaFields(),
      },
    },
  ],
];
