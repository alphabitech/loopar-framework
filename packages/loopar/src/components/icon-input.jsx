import BaseInput from "./input/base-input.jsx";
import Connection from "@connection";
import { DynamicIcon } from "@icon";
import { __ } from "@global/i18n";

export { DynamicIcon };

export default function IconInput(props) {
  const { renderInput, data = { label: "Icon", name: "icon", value: "" } } = BaseInput(props);

  return renderInput(field => {
    return (
      <Connection
        data={{
          ...data,
          options: "Icon Manager",
          description: <label>{__("Powered by")} <a className="text-blue-600 visited:text-purple-600" href="https://lucide.dev/icons/" target="_blank">{__("Lucide")}</a> & <a className="text-blue-600 visited:text-purple-600" href="https://simpleicons.org/" target="_blank">{__("Simple Icons")}</a></label>,
        }}
        value={field.value}
        renderOption={(option) => (
          <div className="flex align-middle">
            <DynamicIcon icon={option} className="w-7 h-7" />
            <div className="pl-2 my-1">{option.label || option.value}</div>
          </div>
        )}
        dontHaveLabel={props.dontHaveLabel}
        simpleInput={props.simpleInput}
      />
    );
  });
}

IconInput.metaFields = () => BaseInput.metaFields();
