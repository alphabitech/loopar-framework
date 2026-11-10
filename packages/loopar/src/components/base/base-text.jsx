import { useDesigner } from "@context/designer-context";

/**
 * The element's `text`. An empty text shows a placeholder while designing
 * only — it is never written into the document (it used to be saved as real
 * content the moment the element mounted).
 */
export default function BaseText(props) {
  const { designerMode } = useDesigner();
  const data = props.data || {};
  const defaultText = props.defaultText || "Text here";

  const getText = () => data.text || (designerMode ? defaultText : "");

  return { getText, defaultText };
}
