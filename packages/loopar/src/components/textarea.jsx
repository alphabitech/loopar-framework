import BaseInput from "@base-input";
import {
  FormControl,
  FormDescription,
  FormLabel
} from "@cn/components/ui/form";
import { Textarea } from "@cn/components/ui/textarea"

export default function TextArea(props) {
  const { renderInput, data } = BaseInput(props);

  return renderInput((field) => {
    const { isInvalid, ...inputProps } = field;

    return (
      <>
        <FormLabel>{data.label}</FormLabel>
        <FormControl className="p-2">
          <Textarea
            {...inputProps}
            placeholder={data.placeholder || data.label}
            className="border border-input rounded-md bg-transparent"
            rows={parseInt(data.rows, 10) || 6}
            {...(data.max_length ? { maxLength: parseInt(data.max_length, 10) || undefined } : {})}
            disabled={[1, "1", true, "true"].includes(data.disabled) || undefined}
          />
        </FormControl>
        {data.description && (
          <FormDescription>
            {data.description}
          </FormDescription>
        )}
      </>
    );
  });
}


 TextArea.metaFields = () => {
  return [
    ...BaseInput.metaFields(),
    {
      group: "form",
      elements: {
        rows: { element: INPUT, data: { format: "int", description: "Visible lines (default 6)." } },
        min_length: { element: INPUT, data: { label: "Min length", format: "int" } },
        max_length: { element: INPUT, data: { label: "Max length", format: "int" } },
      },
    },
  ];
}
