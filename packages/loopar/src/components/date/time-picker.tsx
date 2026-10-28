import React, { useEffect, useReducer, useRef, MouseEvent } from 'react';
import { ToggleGroup, ToggleGroupItem } from "@cn/components/ui/toggle-group";
import { useDesigner } from "@context/designer-context";
import { parseDate, isValidDate } from "@global/date-utils";

interface PropsInterface {
  handleChange: Function,
  value: string | Date | null
}

const parseTime = (time: string | Date | null | undefined): { hour24: number; minute: number } => {
  if (!time) return { hour24: 0, minute: 0 };

  if (typeof time === "string" && /^\d{1,2}:\d{2}/.test(time)) {
    const [h, m] = time.split(":");
    return {
      hour24: Math.min(23, Math.max(0, parseInt(h) || 0)),
      minute: Math.min(59, Math.max(0, parseInt(m) || 0)),
    };
  }

  const parsed = parseDate(time);
  if (isValidDate(parsed)) return { hour24: parsed.getHours(), minute: parsed.getMinutes() };

  return { hour24: 0, minute: 0 };
};

type SelectorType = "Hours" | "Minutes";

type State = {
  hour24: number;
  minute: number;
  selector: SelectorType | null;
  dragging: boolean;
};

type Action =
  | { type: "SET_HOUR_FROM_CLOCK"; clockHour: number }
  | { type: "SET_MINUTE"; minute: number }
  | { type: "SET_AMPM"; amPm: "AM" | "PM" }
  | { type: "BEGIN_DRAG"; selector: SelectorType }
  | { type: "END_DRAG" };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "SET_HOUR_FROM_CLOCK": {
      const isPm = state.hour24 >= 12;
      const ch = action.clockHour % 12;
      const hour24 = isPm ? ch + 12 : ch;
      return hour24 === state.hour24 ? state : { ...state, hour24 };
    }
    case "SET_MINUTE": {
      const minute = Math.min(59, Math.max(0, action.minute));
      return minute === state.minute ? state : { ...state, minute };
    }
    case "SET_AMPM": {
      const isPm = state.hour24 >= 12;
      if (action.amPm === "PM" && !isPm) return { ...state, hour24: state.hour24 + 12 };
      if (action.amPm === "AM" && isPm) return { ...state, hour24: state.hour24 - 12 };
      return state;
    }
    case "BEGIN_DRAG":
      return { ...state, dragging: true, selector: action.selector };
    case "END_DRAG":
      return state.dragging ? { ...state, dragging: false, selector: null } : state;
  }
};

const init = (value: string | Date | null | undefined): State => ({
  ...parseTime(value),
  selector: null,
  dragging: false,
});

const AnalogTimePicker: React.ElementType = (props: PropsInterface) => {
  const { handleChange, value } = props;
  const [state, dispatch] = useReducer(reducer, value, init);
  const userInteracted = useRef<boolean>(false);
  const clockRef = useRef<HTMLDivElement>(null);
  const {designerMode} = useDesigner();

  const amPm = state.hour24 >= 12 ? "PM" : "AM";

  const [clockSize, markSize] = [200, 20];
  const clockRadius = clockSize / 2;
  const markRadius = clockRadius - markSize / 2;
  const hourColor = "bg-slate-500";
  const minuteColor = "bg-green-500";

  const computeAction = (e: MouseEvent<HTMLDivElement>, selector: SelectorType): Action | null => {
    if (!clockRef.current) return null;
    const rect = clockRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX) + Math.PI / 2;
    const degrees = (angle * (180 / Math.PI) + 360) % 360;

    if (selector === "Minutes") {
      const minute = Math.round(degrees / 6) % 60;
      return { type: "SET_MINUTE", minute: isNaN(minute) ? 0 : minute };
    }
    const clockHour = Math.round(degrees / 30) % 12 || 12;
    return { type: "SET_HOUR_FROM_CLOCK", clockHour: isNaN(clockHour) ? 12 : clockHour };
  };

  const handleMouseDown = (selector: SelectorType) => (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if(designerMode) return;
    
    userInteracted.current = true;
    dispatch({ type: "BEGIN_DRAG", selector });
    const action = computeAction(e, selector);
    if (action) dispatch(action);
  };

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!state.dragging || !state.selector || designerMode) return;
    const action = computeAction(e, state.selector);
    if (action) dispatch(action);
  };

  const handleMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if(designerMode) return;
    dispatch({ type: "END_DRAG" });
  };

  const setAmPm = (next: "AM" | "PM") => {
    userInteracted.current = true;
    dispatch({ type: "SET_AMPM", amPm: next });
  };

  useEffect(() => {
    if (!userInteracted.current || designerMode) return;
    const hh = String(state.hour24).padStart(2, "0");
    const mm = String(state.minute).padStart(2, "0");
    handleChange?.(`${hh}:${mm}`);
  }, [state.hour24, state.minute, handleChange, designerMode]);

  const calculateMarkPosition = (index: number, isHourMark: boolean) => {
    const angle = (index * (isHourMark ? 30 : 6)) * (Math.PI / 180);
    const radius = isHourMark ? markRadius - 15 : markRadius;
    const x = clockRadius + radius * Math.cos(angle) - (isHourMark ? markSize / 2 : 1);
    const y = clockRadius + radius * Math.sin(angle) - (isHourMark ? markSize / 2 : 1);
    return { x, y };
  };

  return (
    <div className="flex flex-col items-center p-2 w-full">
      <div className="flex w-full items-center justify-end">
        <ToggleGroup type="single" value={amPm}>
          <ToggleGroupItem onClick={() => setAmPm("AM")} value="AM">Am</ToggleGroupItem>
          <ToggleGroupItem onClick={() => setAmPm("PM")} value="PM">Pm</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div
        className={`relative rounded-full border-4 border-slate-600`}
        style={{ width: clockSize + 10, height: clockSize + 10, padding: 85 }}
        ref={clockRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseUp}
        onMouseUp={handleMouseUp}
      >
        {Array.from({ length: 12 }).map((_, index) => {
          const { x, y } = calculateMarkPosition(index, true);
          const hour = index + 3 > 12 ? index - 9 : index + 3;
          return (
            <div
              key={index}
              className="absolute h-5 w-5 select-none rounded-full text-center leading-5"
              style={{ left: x, top: y }}
            >{hour}</div>
          );
        })}

        {Array.from({ length: 60 }).map((_, index) => {
          const isHourMark = index % 5 === 0;
          const { x, y } = calculateMarkPosition(index, false);

          return (
            <div
              key={`mark-${index}`}
              className={`absolute rounded-full ${isHourMark ? hourColor : minuteColor}`}
              style={{
                left: x, top: y, width: 6, height: 1,
                ...(isHourMark ? { left: x - 3, width: 10, height: 3 } : {}),
                transform: `rotate(${index * 6}deg)`,
              }}
            />
          );
        })}
        <div className={`rounded-full ${hourColor}`} style={{ width: '100%', height: '100%' }}>
          <div
            className={`absolute cursor-grab rounded ${hourColor}`}
            style={{
              width: 18,
              height: `${clockRadius * (0.6)}px`,
              left: 'calc(50% - 9px)',
              bottom: '50%',
              transform: `rotate(${(state.hour24 % 12) * 30}deg)`,
              transformOrigin: '50% 100%',
            }}
            onMouseDown={handleMouseDown("Hours")}
            onMouseUp={handleMouseUp}
          />
          <div
            className={`absolute w-[12px] cursor-grab rounded ${minuteColor}`}
            style={{
              height: `${clockRadius * (0.85)}px`,
              left: 'calc(50% - 6px)',
              bottom: '50%',
              transform: `rotate(${state.minute * 6}deg)`,
              transformOrigin: '50% 100%'
            }}
            onMouseDown={handleMouseDown("Minutes")}
            onMouseUp={handleMouseUp}
          />
          <div
            className={`absolute h-6 w-6 rounded-full ${minuteColor}`}
            style={{
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)'
            }}
          />
          <div
            className="absolute h-4 w-4 rounded-full bg-slate-800"
            style={{
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)'
            }}
          />
        </div>
      </div>
    </div>
  );
};

export default AnalogTimePicker;
