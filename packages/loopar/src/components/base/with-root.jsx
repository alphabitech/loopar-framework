import { rootProps } from "./root-props.js";

/**
 * Gives a block whose own markup has a fixed root the standard root
 * contract (rootProps): a wrapper div receives the layout classes, style,
 * ref, anchor id and custom attributes; the block renders inside it.
 */
export function withRoot(Component) {
  function Rooted(props) {
    const { className, style, ...rest } = props;
    return (
      <div {...rootProps(props)}>
        <Component {...rest} />
      </div>
    );
  }
  Rooted.metaFields = Component.metaFields;
  Rooted.dontHaveMetaElements = Component.dontHaveMetaElements;
  Rooted.displayName = `Rooted(${Component.displayName || Component.name || "Element"})`;
  return Rooted;
}
