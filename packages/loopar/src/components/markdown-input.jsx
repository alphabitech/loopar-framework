import BaseInput from "@base-input";
import Markdown from "@markdown";
import {
  FormControl,
  FormDescription,
  FormLabel,
} from "@cn/components/ui/form";

export default function MarkdownInput(props){
  const {renderInput, data} = BaseInput(props);

  return renderInput((field) => {
    return (
    <>
      {!props.dontHaveLabel && <FormLabel>{data.label}</FormLabel>}
      <FormControl>
        <Markdown
          data={{value: field.value}}
          onChange={field.onChange}
        />
      </FormControl>
      {data.description && <FormDescription>
        {data.description}
      </FormDescription>}
    </>
  )});
}

MarkdownInput.metaFields = () => BaseInput.metaFields();
