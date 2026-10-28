import { useFormContext } from "@form-context";
import { useDesigner } from "@context/designer-context";
import React from "react";

import {
  FormField as BaseFormField,
} from "@cn/components/ui/form"

export const FormField = ({ render, onChange, ...props }) => {
  const { designerMode } = useDesigner();
  const {control, register} = useFormContext();

  /**If fields is not controller by Form */
  const dontHaveForm = props.dontHaveForm;
  const [value, setValue] = React.useState(props.value || "");

  const handleChange = (e) => {
    setValue(e && e.target ? (e.target.files || e.target.value) : e);
    onChange && onChange(e);
  }

  /**
   * If field is not controller by Form
   */
  const field = {
    name: props.name,
    value,
    required: 0,
    onChange: handleChange,
  }

  return (
    designerMode || dontHaveForm  || !register ? (
      render({
        field: field
      })
    ) : (
      <BaseFormField
        {...register(props.name)}
        name={props.name}
        value={props.value}
        control={control}
        render={render}
      />
    )
  )
}
