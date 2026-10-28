import React from "react";

/** `key=value` lines (the value may contain "="). */
const parseOptions = (text = "") => String(text || "").split("\n").reduce((acc, line) => {
  const i = line.indexOf("=");
  if (i > 0) acc[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  return acc;
}, {});

/**
 * Renders an seo element as a head tag. A "title" is not rendered here: the
 * server makes it the page title (one <title>, also on client navigation).
 */
export function SEORender(props){
  const { data={} } = props;
  const options = parseOptions(data.options);
  const tagName = String(data.meta_name || "meta").trim();

  if (tagName === "title") return null;

  return React.createElement(tagName, {...options, key: options.content || options.name || options.property});
}
