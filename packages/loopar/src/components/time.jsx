import BaseInput from "@base-input";
import { parseDate, isValidDate } from "@global/date-utils";
import loopar from "loopar";

import { cn } from "@cn/lib/utils"
import { Button } from "@cn/components/ui/button"
import {
  FormControl,
  FormDescription,
  FormLabel,
} from "@cn/components/ui/form"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cn/components/ui/popover"

import BaseTimePicker from "@@date/time-picker";

import { CalendarIcon } from "lucide-react";

const toHHmm = (val) => {
  if (!val) return "00:00";
  if (typeof val === "string" && /^\d{1,2}:\d{2}/.test(val)) return val.slice(0, 5);
  const d = parseDate(val);
  return isValidDate(d)
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : "00:00";
};

export default function TimePicker(props) {
  const { renderInput, data={} } = BaseInput(props);

  return renderInput(field => {
    const initialHour = toHHmm(field.value);
    const display = field.value ? loopar.dateUtils.getTime(field.value, "DB") : null;

    const setTimeHandler = (val) => {
      const result = loopar.dateUtils.getTime(val);
      field.onChange({ target: { value: result } });
    };

    return (
      <div className="flex flex-col">
        <FormLabel>{data.label}</FormLabel>
        <Popover>
          <PopoverTrigger asChild>
            <FormControl>
              <Button
                variant={"outline"}
                className={cn(
                  "w-[240px] pl-3 text-left font-normal",
                  !display && "text-muted-foreground"
                )}
              >
                {display ?? <span>Pick a Time</span>}
                <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
              </Button>
            </FormControl>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <BaseTimePicker value={initialHour} handleChange={setTimeHandler}/>
          </PopoverContent>
        </Popover>
        <FormDescription>
          {data.description}
        </FormDescription>
      </div>
    )
  })
}
