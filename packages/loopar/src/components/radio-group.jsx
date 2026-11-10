import BaseInput from "@base-input";
import loopar from "loopar";
import { RadioGroup, RadioGroupItem } from "@cn/components/ui/radio-group";
import { Checkbox } from "@cn/components/ui/checkbox";
import { FormControl, FormDescription, FormLabel } from "@cn/components/ui/form";
import { multipleValues } from "@global/element-definition";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";

/** "value:Label" lines → [{ value, label }]. */
const parseOptions = (options) => String(options ?? "")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const i = line.indexOf(":");
    return i >= 0 ? { value: line.slice(0, i), label: line.slice(i + 1) } : { value: line, label: line };
  });

/**
 * Visible choices: radio buttons (one value) or, with `multiple`, a group of
 * checkboxes (a JSON list of values). Options: one per line, value:Label.
 */
export default function MetaRadioGroup(props) {
  const { renderInput, data } = BaseInput(props);
  const options = parseOptions(data.options);
  const multiple = loopar.utils.trueValue(data.multiple);
  const horizontal = data.layout === "horizontal";
  const disabled = loopar.utils.trueValue(data.disabled);
  const listClass = cn("flex gap-3", horizontal ? "flex-row flex-wrap gap-x-6" : "flex-col");

  return renderInput((field) => {
    const id = (v) => `${field.name}-${String(v).replace(/[^\w-]/g, "_")}`;

    return (
      <>
        {!props.dontHaveLabel && <FormLabel>{data.label}</FormLabel>}
        <FormControl>
          {multiple ? (
            <div className={listClass} role="group" aria-label={data.label}>
              {options.map(({ value, label }) => {
                const selected = multipleValues(field.value);
                const checked = selected.includes(value);
                return (
                  <label key={value} htmlFor={id(value)} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={id(value)}
                      checked={checked}
                      disabled={disabled}
                      onCheckedChange={(on) => {
                        const next = on ? [...new Set([...selected, value])] : selected.filter((v) => v !== value);
                        field.onChange(JSON.stringify(next));
                      }}
                    />
                    {__(label)}
                  </label>
                );
              })}
            </div>
          ) : (
            <RadioGroup
              className={listClass}
              value={field.value ?? ""}
              onValueChange={(v) => field.onChange(v)}
              disabled={disabled}
            >
              {options.map(({ value, label }) => (
                <label key={value} htmlFor={id(value)} className="flex items-center gap-2 text-sm">
                  <RadioGroupItem id={id(value)} value={value} />
                  {__(label)}
                </label>
              ))}
            </RadioGroup>
          )}
        </FormControl>
        {data.description && <FormDescription>{data.description}</FormDescription>}
      </>
    );
  });
}

MetaRadioGroup.metaFields = () => [
  ...BaseInput.metaFields(),
  {
    group: "form",
    elements: {
      options: { element: TEXTAREA, data: { description: "One option per line: value or value:Label." } },
      multiple: { element: SWITCH, data: { label: "Multiple", description: "Checkboxes: several values (stored as a JSON list)." } },
      layout: {
        element: SELECT,
        data: { label: "Layout", options: [{ value: "vertical", label: "Vertical" }, { value: "horizontal", label: "Horizontal" }] },
      },
    },
  },
];
