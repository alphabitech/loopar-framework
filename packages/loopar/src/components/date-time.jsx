import BaseInput from "@base-input";
import loopar from "loopar";
import { format } from 'date-fns';
import { parseDate, isValidDate } from "@global/date-utils";

import { cn } from "@cn/lib/utils"
import { Button } from "@cn/components/ui/button"
import { Calendar } from "@cn/components/ui/calendar"
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

import TimePicker from "@@date/time-picker";
import { CalendarIcon, TimerIcon } from "lucide-react";
import { Tabs as BaseTabs, TabsContent, TabsList, TabsTrigger } from "@cn/components/ui/tabs";

export default function DateTime(props) {
  const { renderInput, data } = BaseInput(props);

  return renderInput(field => {
    const parsed = field.value ? parseDate(field.value) : null;
    const isValid = isValidDate(parsed);
    const baseDate = isValid ? parsed : null;
    const initialHour = isValid ? format(parsed, "HH:mm") : "00:00";

    const disabledDays = [];
    if (loopar.utils.trueValue(data.disable_past_dates)) disabledDays.push({ before: new Date() });
    if (loopar.utils.trueValue(data.disable_future_dates)) disabledDays.push({ after: new Date() });
    const minDate = data.min_date ? parseDate(data.min_date) : null;
    const maxDate = data.max_date ? parseDate(data.max_date) : null;
    if (isValidDate(minDate)) disabledDays.push({ before: minDate });
    if (isValidDate(maxDate)) disabledDays.push({ after: maxDate });

    const setTimeHandler = (val) => {
      const [hours, minutes] = val.split(":").map(v => parseInt(v) || 0);
      const date = baseDate ? new Date(baseDate) : new Date();
      date.setHours(hours);
      date.setMinutes(minutes);
      date.setSeconds(0);

      field.onChange({target: { value: date }});
    };

    const setDateHandler = (val) => {
      if (!val) return;
      const newDate = parseDate(val);
      const date = baseDate ? new Date(baseDate) : new Date();
      // One call: separate setMonth/setDate overflow (Jan 31 → Feb → Mar 3).
      date.setFullYear(newDate.getFullYear(), newDate.getMonth(), newDate.getDate());

      field.onChange({target: { value: date }});
    }

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
                  !isValid && "text-muted-foreground"
                )}
              >
                {isValid ? (
                  format(baseDate, "PPP HH:mm")
                ) : (
                  <span>Pick a date & time</span>
                )}
                <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
              </Button>
            </FormControl>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <BaseTabs className="w-[280px]" defaultValue="calendar">
              <TabsList className="flex justify-between">
                <TabsTrigger className="w-full" value="calendar"><CalendarIcon /></TabsTrigger>
                <TabsTrigger className="w-full" value="time"><TimerIcon /></TabsTrigger>
              </TabsList>
              <TabsContent value="calendar">
                <Calendar
                  mode="single"
                  selected={baseDate ?? undefined}
                  onSelect={setDateHandler}
                  disabled={disabledDays.length ? disabledDays : undefined}
                  autoFocus
                  className="w-full"
                />
              </TabsContent>
              <TabsContent value="time">
                <div className="flex flex-col flex-wrap items-start gap-2 @md:flex-row w-full">
                <TimePicker value={initialHour} handleChange={setTimeHandler} />
                </div>
              </TabsContent>
            </BaseTabs>
          </PopoverContent>
        </Popover>
        <FormDescription>
          {data.description}
        </FormDescription>
      </div>
    )
  })
}

DateTime.metaFields = () => [
  ...BaseInput.metaFields(),
  {
    group: "form",
    elements: {
      min_date: {
        element: DATE,
        data: { description: "Earliest selectable date. Leave empty for no lower limit." },
      },
      max_date: {
        element: DATE,
        data: { description: "Latest selectable date. Leave empty for no upper limit." },
      },
      disable_past_dates: {
        element: SWITCH,
        data: { description: "Disallow picking dates before today." },
      },
      disable_future_dates: {
        element: SWITCH,
        data: { description: "Disallow picking dates after today." },
      },
    },
  },
];