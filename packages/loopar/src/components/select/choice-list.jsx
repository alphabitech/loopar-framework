import { Checkbox } from "@cn/components/ui/checkbox";
import { cn } from "@cn/lib/utils";
import { groupOptions } from "./options.js";

/**
 * Multiple choice shown as visible checkboxes (instead of chips in a
 * combobox), grouped under their headings. `max` stops new checks once
 * reached.
 */
export function ChoiceList({ name, options, values, onChange, disabled, max, horizontal }) {
  const reached = max > 0 && values.length >= max;
  const id = (v) => `${name}-${String(v).replace(/[^\w-]/g, "_")}`;

  return (
    <div className="space-y-3" role="group">
      {groupOptions(options).map(({ group, options: items }) => (
        <fieldset key={group ?? "__"} className="space-y-2">
          {group && <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</legend>}
          <div className={cn("flex gap-3", horizontal ? "flex-row flex-wrap gap-x-6" : "flex-col")}>
            {items.map((o) => {
              const value = String(o.value);
              const checked = values.includes(value);
              return (
                <label key={value} htmlFor={id(value)} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={id(value)}
                    checked={checked}
                    disabled={disabled || (!checked && reached)}
                    onCheckedChange={(on) => onChange(on ? [...values, value] : values.filter((v) => v !== value))}
                  />
                  {o.formattedValue || o.label || value}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
