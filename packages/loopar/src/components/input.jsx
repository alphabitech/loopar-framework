import BaseInput from "@base-input";
import {FormLabel, invalidClass} from "./input/index.js";
import { Input as FormInput } from "@cn/components/ui/input";
import loopar from "loopar";
import {inputType, COLUMN_FORMATS} from '@global/element-definition'
import {
  FormControl,
  FormDescription
} from "@cn/components/ui/form";

// Formats that have their own element in the palette.
const DEDICATED_FORMATS = new Set(["date", "datetime", "time", "boolean", "password", "blob", "increments"]);

/** Custom attributes that belong on the <input> itself (autocomplete, inputmode…). */
const INPUT_ATTRIBUTES = new Set(["autocomplete", "inputmode", "enterkeyhint", "spellcheck"]);
const inputAttributes = (props) => Object.fromEntries(
  Object.entries(props).filter(([key, value]) => typeof value === "string" && (INPUT_ATTRIBUTES.has(key) || key.startsWith("data-") || key.startsWith("aria-")))
);

export default function Input(props) {
  const { renderInput, data } = BaseInput(props);
  const type = props.type || inputType[(data?.format || "data").toLowerCase()] || "text";
  const _type = type == "number" ? {
    type: type,
    min: typeof data.min != "undefined" ? data.min : -Infinity,
    max: typeof data.max != "undefined" ? data.max : Infinity,
  } : { type };
  const parsedData = JSON.parse(JSON.stringify(data));

  const attributtes = ["readonly", "hidden", "disabled"];
  const _props = Object.entries(parsedData).reduce((acc, [key, value]) => {
    if (attributtes.includes(key)) {
      loopar.utils.trueValue(value) && loopar.utils.binaryValue(value) == 1 && (acc[key] = true);
    }

    return acc;
  }, {});

  delete _props.key;

  return renderInput((field) => {
    // isInvalid is UI state for styling, not a DOM attribute.
    const { isInvalid, ...inputProps } = field;

    return (
      <>
        <FormLabel {...props} field={field} />
        <FormControl>
          <FormInput
            {...inputAttributes(props)}
            {..._props}
            {...(data.max_length ? { maxLength: parseInt(data.max_length, 10) || undefined } : {})}
            placeholder={data.placeholder || data.label}
            {...inputProps}
            {..._type}
            className={isInvalid ? invalidClass.border : ""}
          />
        </FormControl>
        {(data.description) && <FormDescription>
          {data.description}
        </FormDescription>}
      </>
    )
  });
}
Input.metaFields = () => {
  return [
    ...BaseInput.metaFields(),
    [
      {
        group: "form",
        elements: {
          format: {
            element: SELECT,
            data: {
              // Types with a dedicated element (date, switch, password…) are not offered here.
              options: Object.entries(COLUMN_FORMATS).filter(([value]) => !DEDICATED_FORMATS.has(value)).map(([value, def]) => ({
                value,
                label: value.charAt(0).toUpperCase() + value.slice(1),
                description: def.description,
              })),
              selected: "data",
            },
          },
          min: {
            element: "input",
            data: {format: "int"}
          },
          max: {
            element: "input",
            data: {format: "int"}
          },
          min_length: { element: INPUT, data: { label: "Min length", format: "int" } },
          max_length: { element: INPUT, data: { label: "Max length", format: "int" } },
          pattern: {
            element: INPUT,
            data: {
              label: "Pattern",
              description: "Regular expression the whole value must match, e.g. [A-Z]{3}-\\d{4}.",
            },
          },
          pattern_message: { element: INPUT, data: { label: "Pattern message", description: "Error shown when the pattern does not match." } },
          not_validate_type: { element: SWITCH },
          formula: {
            element: TEXTAREA,
            data: {
              description: "Computed field (read-only), recalculated as you type and on save. E.g. abs(qty) * unit_cost · round(subtotal * 0.15, 2) · if(type = 'Return', -qty, qty) · sum(lines.total) / count(lines) for a child table.",
            },
          },
        }
      }
    ]
  ]
}