import BaseInput from "@base-input";
import {
  FormControl,
  FormDescription,
  FormLabel,
} from "@cn/components/ui/form";
import { Input as FormInput } from "@cn/components/ui/input";
import { Button } from "@cn/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@cn/components/ui/table";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { __ } from "@global/i18n";

function parsePlainText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^:=]+)[:=](.*)$/);
      if (m) return { name: m[1].trim(), value: m[2].trim() };
      return { name: line, value: "" };
    });
}

function parseRows(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) {
    return value.map((r) => ({ name: r?.name ?? "", value: r?.value ?? "" }));
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return [];
    try {
      return parseRows(JSON.parse(t));
    } catch {
      return parsePlainText(t);
    }
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([name, v]) => ({ name, value: v ?? "" }));
  }
  return [];
}

const Metadata = (props) => {
  return (
    <BaseInput
      {...props}
      render={(field, data) => {
        const rows = parseRows(field.value);
        const keyLabel = data.key_label || "Name";
        const valueLabel = data.value_label || "Value";

        const commit = (next) => field.onChange({ target: { value: JSON.stringify(next) } });
        const addRow = () => commit([...rows, { name: "", value: "" }]);
        const removeRow = (index) => commit(rows.filter((_, i) => i !== index));
        const updateCell = (index, key, val) => commit(rows.map((r, i) => (i === index ? { ...r, [key]: val } : r)));

        return (
          <>
            {data.label && props.dontHaveLabel !== true && (
              <FormLabel>{data.label}</FormLabel>
            )}
            <FormControl>
              <div className="flex flex-col gap-2">
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-1/2">{keyLabel}</TableHead>
                        <TableHead className="w-1/2">{valueLabel}</TableHead>
                        <TableHead className="w-12 text-center">...</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.length === 0 && (
                        <TableRow>
                          <TableCell
                            colSpan={3}
                            className="py-3 text-center text-muted-foreground"
                          >
                            {__("No metadata yet")}
                          </TableCell>
                        </TableRow>
                      )}
                      {rows.map((row, index) => (
                        <TableRow key={index}>
                          <TableCell className="p-1">
                            <FormInput
                              value={row.name}
                              placeholder={keyLabel}
                              onChange={(e) =>
                                updateCell(index, "name", e.target.value)
                              }
                            />
                          </TableCell>
                          <TableCell className="p-1">
                            <FormInput
                              value={row.value}
                              placeholder={valueLabel}
                              onChange={(e) =>
                                updateCell(index, "value", e.target.value)
                              }
                            />
                          </TableCell>
                          <TableCell className="p-1 text-center">
                            <Button
                              type="button"
                              variant="destructive"
                              size="icon"
                              onClick={(e) => {
                                e.preventDefault();
                                removeRow(index);
                              }}
                            >
                              <Trash2Icon size={16} />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={(e) => {
                      e.preventDefault();
                      addRow();
                    }}
                  >
                    <PlusIcon className="mr-1" size={16} />
                    {__("Add row")}
                  </Button>
                </div>
                {data.description && (
                  <FormDescription>{data.description}</FormDescription>
                )}
              </div>
            </FormControl>
          </>
        );
      }}
    />
  );
};


Metadata.metaFields = () => {
  return [
    ...BaseInput.metaFields(),
    [
      {
        group: "form",
        elements: {
          key_label: {
            element: INPUT,
            data: { description: "Header for the name column (default: Name)" },
          },
          value_label: {
            element: INPUT,
            data: { description: "Header for the value column (default: Value)" },
          },
        },
      },
    ],
  ];
};

export default Metadata;