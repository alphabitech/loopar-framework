/**
 * Document base — public API available inside EVERY entry:
 *
 *   import { useDocument, DefaultView, useHandlers } from "@loopar/document";
 *
 * Kind-specific APIs live next to their kind: "@loopar/form",
 * "@loopar/list", "@loopar/page". See README.md for the chain.
 */
export { useDocument, Layout, DefaultView } from "./base/provider";
export { useViewOptions } from "./base/view-options";
export { useActions, useHandlers, useDocumentConfig, useFieldEvent } from "./base/extensions";
export { useFieldMeta } from "./base/use-field-meta";
export { HeaderTabs } from "./chrome/header-tabs";
export { useReserveSidePanel } from "./chrome/side-panel";
export { normalizeActions, planActions } from "./chrome/toolbar";
