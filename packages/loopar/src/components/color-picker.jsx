import BaseInput from "@base-input";
import { useRef, useState, useEffect, useCallback } from "react";

import {
  FormControl,
  FormDescription,
  FormLabel,
} from "@cn/components/ui/form";

import {loopar} from 'loopar';

import { RgbaColorPicker } from "react-colorful";

import useClickOutside from "./color-picker/useClickOutside";
import "./color-picker/style.css";
import { __ } from "@global/i18n";

function normalizeColor(inputColor) {
  try {
    const color = typeof inputColor === 'object' ? inputColor : JSON.parse(inputColor);
    const { r = 0, g = 0, b = 0, a = 1 } = color;
    return { r, g, b, a };
  } catch (e) {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
}

function serializeColor(color) {
  const { r, g, b, a } = normalizeColor(color);
  return JSON.stringify({ r, g, b, a });
}

export default function PopoverPicker(props) {
  const popover = useRef();
  const [isOpen, toggle] = useState(false);
  const [localColor, setLocalColor] = useState(normalizeColor(props.value));

  const commitColor = useCallback(
    (field, color) => {
      field.onChange(serializeColor(color));
    },
    []
  );

  return (
    <BaseInput
      {...props}
      render={(field, data) => {
        useEffect(() => {
          if (!isOpen) {
            setLocalColor(normalizeColor(field.value));
          }
        }, [field.value, isOpen]);

        useClickOutside(popover, () => {
          if (isOpen) {
            toggle(false);
            commitColor(field, localColor);
          }
        });

        const handleColorChange = (color) => {
          setLocalColor(normalizeColor(color));
          commitColor(field, color);
        };

        const clearColor = (e) => {
          e.preventDefault();
          e.stopPropagation();
          setLocalColor({ r: 0, g: 0, b: 0, a: 0 });
          commitColor(field, { r: 0, g: 0, b: 0, a: 0 });
        }

        return (
          <>
          <FormLabel>
            {data.label}
          </FormLabel>
          <FormControl>
            <div className="flex h-10 w-full bg-input border rounded-md relative">
              <div
                className="w-full h-full cursor-pointer rounded-md"
                style={{ backgroundColor: loopar.utils.objToRGBA(localColor) }}
                onClick={() => toggle(true)}  
              />

              {isOpen && (
                <div
                  className="absolute bg-secondary border-input p-4 rounded custom-layout custom-pointers"
                  ref={popover}
                >
                  <RgbaColorPicker color={localColor} onChange={handleColorChange} />
                  <div className="flex justify-between">
                    <button
                      className="mt-2 btn btn-primary"
                      onClick={() => {
                        toggle(false);
                        commitColor(field, localColor);
                      }}
                    >
                      {__("OK")}
                    </button>
                    <button
                      className="mt-2 btn btn-secondary"
                      onClick={clearColor}
                    >
                      {__("Clear")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </FormControl>
          {data.description && <FormDescription>{data.description}</FormDescription>}
          </>
        );
      }}
    />
  );
}