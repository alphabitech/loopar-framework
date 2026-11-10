import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { Slot } from "@radix-ui/react-slot"
import {
  Controller,
  ControllerProps,
  FieldPath,
  FieldValues,
  FormProvider,
  useFormContext,
} from "react-hook-form"

import { cn } from "@cn/lib/utils"
import { Label } from "@cn/components/ui/label"
// @ts-ignore — shared JS module (core/global/i18n.js)
import { __ } from "@global/i18n"

/** String children render in the page language; anything else as is. */
const t = (children: React.ReactNode) => (typeof children === "string" ? __(children) : children)

const Form = FormProvider

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
> = {
  name: TName
}

const FormFieldContext = React.createContext<FormFieldContextValue>(
  {} as FormFieldContextValue
)

const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
>({
  ...props
}: ControllerProps<TFieldValues, TName>) => {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  )
}

const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext)
  const itemContext = React.useContext(FormItemContext)
  const { getFieldState, formState } = useFormContext()

  const fieldState = getFieldState(fieldContext.name, formState)

  if (!fieldContext) {
    throw new Error("useFormField should be used within <FormField>")
  }

  const { id } = itemContext

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  }
}

type FormItemContextValue = {
  id: string
  /** Shows the required mark on the item's label. */
  required?: boolean
}

const FormItemContext = React.createContext<FormItemContextValue>(
  {} as FormItemContextValue
)

const FormItem = ({ className, required, ...props }: React.HTMLAttributes<HTMLDivElement> & { required?: boolean }) => {
  const id = React.useId()

  return (
    <FormItemContext.Provider value={{ id, required }}>
      <div  className={cn("space-y-2", className)} {...props} />
    </FormItemContext.Provider>
  )
}
FormItem.displayName = "FormItem"

/**
 * Optional adornment rendered at the end of a field's label row, by field
 * name (e.g. a "translate" button on translatable fields). Provided by the
 * app around a form; null by default.
 */
type FormLabelAddon = (name: string) => React.ReactNode
const FormLabelAddonContext = React.createContext<FormLabelAddon | null>(null)

const FormLabel = ({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>) => {
  const { error, formItemId, name } = useFormField()
  const { required } = React.useContext(FormItemContext)
  const addonFor = React.useContext(FormLabelAddonContext)
  const addon = name && addonFor ? addonFor(name) : null

  const label = (
    <Label
      className={cn(error && "text-destructive", className)}
      htmlFor={formItemId}
      {...props}
    >
      {t(children)}
      {required && <span className="text-destructive" aria-hidden="true"> *</span>}
    </Label>
  )

  return addon ? (
    <div className="flex items-center justify-between gap-2">
      {label}
      {addon}
    </div>
  ) : label
}
FormLabel.displayName = "FormLabel";

const FormControl = ({ ...props }: React.ComponentPropsWithoutRef<typeof Slot>) => {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField()

  return (
    <Slot
      id={formItemId}
      aria-describedby={
        !error
          ? `${formDescriptionId}`
          : `${formDescriptionId} ${formMessageId}`
      }
      aria-invalid={!!error}
      {...props}
    />
  )
}
FormControl.displayName = "FormControl"

const FormDescription = ({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => {
  const { formDescriptionId } = useFormField()

  return (
    <p
      id={formDescriptionId}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    >
      {t(children)}
    </p>
  )
}
FormDescription.displayName = "FormDescription"

const FormMessage = ({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => {
  const { error, formMessageId } = useFormField()
  const body = t(error ? String(error?.message) : children)

  if (!body) {
    return null
  }

  return (
    <p
      id={formMessageId}
      className={cn("text-sm font-medium text-destructive", className)}
      {...props}
    >
      {body}
    </p>
  )
}
FormMessage.displayName = "FormMessage"

export {
  useFormField,
  FormLabelAddonContext,
  Form,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  FormField,
}
