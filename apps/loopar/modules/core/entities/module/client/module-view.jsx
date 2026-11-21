'use strict';

import { useLocation } from 'react-router';
import { useDocument, HeaderTabs } from "@loopar/document";
import { PlusIcon } from "lucide-react";
import EntityList from "../../entity/client/entity-list";
import { __ } from "loopar";

/** The module is fixed by the route (`/desk/<Module>`): no point searching by it. */
const HIDDEN_SEARCH_FIELDS = ["module"];

export const config = { onlyGrid: true, hasSearchForm: true, hiddenSearchFields: HIDDEN_SEARCH_FIELDS };

export default function ModuleView() {
  const { Document } = useDocument();
  const { search } = useLocation();
  const types = Document?.__TYPES__ || [];
  const current = new URLSearchParams(search).get("type") || Document?.__TYPE__;
  const currentType = types.find((t) => t.name === current);

  // "New" creates a document of the active tab's type (the list itself is presented as "Module").
  const actions = currentType ? {
    new: { label: `${__("New")} ${__(currentType.singular)}`, icon: PlusIcon, primary: true, to: `/desk/${currentType.name}/create` },
  } : {};

  // One tab per document type present in the module, with its count: the header's third row.
  const headerTabs = types.length > 1 ? (
    <HeaderTabs
      label={__("Document types")}
      items={types.map((t) => ({
        key: t.name,
        label: __(t.label),
        count: t.count,
        to: `?type=${encodeURIComponent(t.name)}`,
        active: t.name === current,
      }))}
    />
  ) : null;

  return <EntityList actions={actions} headerTabs={headerTabs} />;
}
