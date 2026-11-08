import BaseInput from "@base-input";
import loopar from "loopar";
import * as RadioGroup from "@radix-ui/react-radio-group";

import {Droppable} from "@droppable";

import {
  FormItem,
  FormControl,
  FormDescription,
  FormLabel,
  FormMessage
} from "@cn/components/ui/form";
import { __ } from "@global/i18n";

export default function MetaRadioGroup(props) {
  const { renderInput, data } = BaseInput(props);
  const type = props.type || data?.type || "input";
  const parsedData = JSON.parse(JSON.stringify(data));

  const attributtes = ["readonly", "hidden", "mandatory", "disabled"];
  const _props = Object.entries(parsedData).reduce((acc, [key, value]) => {
    if (attributtes.includes(key)) {
      loopar.utils.trueValue(value) && loopar.utils.binaryValue(value) == 1 && (acc[key] = true);
    }

    return acc;
  }, {});

  delete _props.key;

  return (
    <h1 className="p-4 bg-red-500/50">{__("Under construction")}</h1>
  )
  return renderInput((field) => {
    return (
      <>
        {!props.dontHaveLabel && <FormLabel>{data.label}</FormLabel>}
        <FormControl>
          <FormItem className="space-y-3">
            <FormLabel>{__("Notify me about...")}</FormLabel>
            <FormControl>
              <RadioGroup.Root
                className="flex flex-col gap-2.5"
                defaultValue="default"
                aria-label={__("View density")}
              >
                <Droppable
                  {...props}
                />
              </RadioGroup.Root>
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormControl>
        {data.description && <FormDescription>
          {data.description}
        </FormDescription>}
      </>
    )
  });
}

MetaRadioGroup.metaFields = () => {
  return {
    group: "form",
    elements: {
      options: {
        element: SELECT,
      }
    }
  };
}