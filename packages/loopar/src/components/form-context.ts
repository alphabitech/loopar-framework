/**
 * The form context and its read hooks, apart from `form-provider.tsx` on purpose:
 * Meta (every element, web pages included), inputs and desk chrome only *read*
 * the form, and must not pull react-hook-form + zod into chunks that never
 * mount a FormProvider. Only type imports from react-hook-form here.
 */
import { createContext, useContext } from "react";
import type { UseFormReturn, FieldValues } from "react-hook-form";

/** Reference to the document / screen context that receives submit. */
export interface LooparFormDocRef {
  save?: (values: FieldValues) => void | Promise<void>;
  Form?: UseFormReturn<FieldValues>;
  /** In real documents this is often a subset of `FormState` or a custom map. */
  formFields?: unknown;
}

export type LooparBaseFormContext = UseFormReturn<FieldValues> & {
  values: FieldValues | undefined;
  docRef?: LooparFormDocRef | null;
};

export const BaseFormContext = createContext<LooparBaseFormContext | undefined>(
  undefined,
);

/** Live form values, or `undefined` outside a form (safe anywhere). */
export function useFormValues(): FieldValues | undefined {
  return useContext(BaseFormContext)?.values;
}

export function useFormContext(): LooparBaseFormContext {
  const ctx = useContext(BaseFormContext);
  if (ctx === undefined) {
    throw new Error(
      "useFormContext must be used within FormWrapper / FormProvider.",
    );
  }
  return ctx;
}
