import BaseInput from "@base-input";
import loopar from "loopar";
import { FormControl, FormDescription, FormLabel } from "@cn/components/ui/form";

const num = (v, fallback) => {
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
};

/** Numeric slider (native range input) with the current value beside it. */
export default function MetaRange(props) {
  const { renderInput, data } = BaseInput(props);
  const min = num(data.min, 0);
  const max = num(data.max, 100);
  const step = num(data.step, 1);

  return renderInput((field) => {
    const value = field.value === "" || field.value === null || field.value === undefined ? min : num(field.value, min);
    return (
      <>
        <FormLabel>{data.label}</FormLabel>
        <FormControl>
          <div className="flex items-center gap-3">
            <input
              type="range"
              name={field.name}
              min={min}
              max={max}
              step={step}
              value={value}
              disabled={loopar.utils.trueValue(data.disabled)}
              onChange={(e) => field.onChange(Number(e.target.value))}
              className="h-2 w-full cursor-pointer accent-primary"
              aria-valuetext={`${value}${data.unit || ""}`}
            />
            <output className="min-w-12 text-right text-sm tabular-nums">{value}{data.unit || ""}</output>
          </div>
        </FormControl>
        {data.description && <FormDescription>{data.description}</FormDescription>}
      </>
    );
  });
}

MetaRange.metaFields = () => [
  ...BaseInput.metaFields(),
  {
    group: "form",
    elements: {
      min: { element: INPUT, data: { format: "decimal", default_value: 0 } },
      max: { element: INPUT, data: { format: "decimal", default_value: 100 } },
      step: { element: INPUT, data: { format: "decimal", default_value: 1 } },
      unit: { element: INPUT, data: { label: "Unit", description: "Shown after the value, e.g. %, kg." } },
    },
  },
];
