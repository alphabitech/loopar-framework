import { useState } from "react";
import BaseInput from "@base-input";
import loopar from "loopar";
import { Star } from "lucide-react";
import { FormControl, FormDescription, FormLabel } from "@cn/components/ui/form";
import { cn } from "@cn/lib/utils";
import { __ } from "@global/i18n";

/** Star rating (1..max, stored as an integer); keyboard friendly radios. */
export default function MetaRating(props) {
  const { renderInput, data } = BaseInput(props);
  const max = Math.min(10, Math.max(3, parseInt(data.max, 10) || 5));
  const disabled = loopar.utils.trueValue(data.disabled);
  const [hover, setHover] = useState(0);

  return renderInput((field) => {
    const value = parseInt(field.value, 10) || 0;
    const shown = hover || value;
    return (
      <>
        <FormLabel>{data.label}</FormLabel>
        <FormControl>
          <div role="radiogroup" aria-label={data.label} className="flex items-center gap-1" onMouseLeave={() => setHover(0)}>
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={value === n}
                aria-label={__("{0} of {1}", [n, max])}
                disabled={disabled}
                onMouseEnter={() => setHover(n)}
                onClick={() => field.onChange(value === n ? 0 : n)}
                className="rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                <Star className={cn("size-6 transition-colors", n <= shown ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40")} />
              </button>
            ))}
          </div>
        </FormControl>
        {data.description && <FormDescription>{data.description}</FormDescription>}
      </>
    );
  });
}

MetaRating.metaFields = () => [
  ...BaseInput.metaFields(),
  {
    group: "form",
    elements: {
      max: { element: INPUT, data: { label: "Stars", format: "int", default_value: 5, description: "3 to 10." } },
    },
  },
];
