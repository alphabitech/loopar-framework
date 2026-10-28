import {loopar} from "loopar";
import { Checkbox} from "@cn/components/ui/checkbox";
import BaseInput from "@base-input";

import {
  FormControl,
  FormDescription,
  FormLabel,
} from "@cn/components/ui/form";

const LINK_RE = /\[([^\]]+)\]\(((?:\/|https?:\/\/|mailto:)[^\s)]*)\)/g;

/**
 * Text with markdown links (`[Privacy Notice](/legal/privacy-notice)`) as
 * anchors: a consent checkbox links to the notice it accepts. Anything else
 * stays plain text.
 */
function withLinks(text) {
  const value = String(text ?? "");
  const parts = [];
  let last = 0;
  for (const match of value.matchAll(LINK_RE)) {
    if (match.index > last) parts.push(value.slice(last, match.index));
    const [, label, href] = match;
    const external = /^https?:/.test(href);
    parts.push(
      <a key={match.index} href={href} className="underline underline-offset-2 text-primary"
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{label}</a>
    );
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push(value.slice(last));
  return parts.length ? parts : value;
}

export default function DefaultCheckbox(props) {
  const Comp = props.Comp || Checkbox;

  return (
    <BaseInput
      {...props}
      render={(field, data) => {
        const handleCheckedChange = (checked) => {
          field.onChange(loopar.utils.trueToBinary(checked));
        };
        return (
          <div className="gap-2">
            <div className="flex items-center">
              <FormControl>
                <Comp
                  onCheckedChange={handleCheckedChange}
                  checked={loopar.utils.trueToBinary(field.value) === 1}
                  className="-switch- hover:border-slate-500/70"
                />
              </FormControl>
              <FormLabel className="pl-2">{withLinks(data.label)}</FormLabel>
            </div>
            {data.description && (
              <FormDescription>{withLinks(data.description)}</FormDescription>
            )}
          </div>
        );
      }}
    />
  );
}

DefaultCheckbox.metaFields = () => {
  return BaseInput.metaFields();
}