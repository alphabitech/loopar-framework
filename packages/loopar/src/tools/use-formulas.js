import { useEffect, useMemo } from "react";
import { computeFormulas, formulaFields, sameComputedValue, tableRows } from "@global/formula";

/**
 * Live computed fields (`data.formula`). The server recomputes them on save;
 * these hooks only mirror the result while the user types. A field is written
 * only when its value actually changes, so the watch → set loop settles.
 */

const set = (form, name, value) => form.setValue(name, value, { shouldDirty: false, shouldValidate: false });

/** Formula fields of a flat form, computed over its live `values`. */
export function useFormulas(form, structure, values) {
  const formulas = useMemo(() => formulaFields(structure), [structure]);

  useEffect(() => {
    if (!form || !values || !Object.keys(formulas).length) return;
    const computed = computeFormulas(formulas, values);
    for (const [name, value] of Object.entries(computed)) {
      if (!sameComputedValue(values[name], value)) set(form, name, value);
    }
  }, [form, formulas, values]);
}

/** Formula fields of a child table, computed per row (`<path>.<index>.<field>`). */
export function useRowFormulas(form, structure, rows, path = "rows") {
  const formulas = useMemo(() => formulaFields(structure), [structure]);

  useEffect(() => {
    if (!form || !Object.keys(formulas).length) return;
    tableRows(rows).forEach((row, index) => {
      if (!row) return;
      const computed = computeFormulas(formulas, row);
      for (const [name, value] of Object.entries(computed)) {
        if (!sameComputedValue(row[name], value)) set(form, `${path}.${index}.${name}`, value);
      }
    });
  }, [form, formulas, rows, path]);
}
