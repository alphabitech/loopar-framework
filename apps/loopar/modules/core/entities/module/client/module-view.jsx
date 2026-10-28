'use strict';

import { useLocation } from 'react-router';
import { useDocument } from "@loopar/document";
import { Link } from "@link";
import { cn } from "@cn/lib/utils";
import { PlusIcon } from "lucide-react";
import EntityList from "../../entity/client/entity-list";

/** The module is fixed by the route (`/desk/<Module>`): no point searching by it. */
const HIDDEN_SEARCH_FIELDS = ["module"];

export const config = { onlyGrid: true, hasSearchForm: true, hiddenSearchFields: HIDDEN_SEARCH_FIELDS };

/** Segmented tabs, one per document type present in the module, with its count. */
function TypeTabs({ types, current }) {
  if (types.length < 2) return null;

  return (
    <nav aria-label="Document types" className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg bg-muted/60 p-1">
      {types.map((t) => {
        const active = t.name === current;
        return (
          <Link
            key={t.name}
            award={false}
            bare
            to={`?type=${encodeURIComponent(t.name)}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            <span className={cn(
              "rounded-full px-1.5 text-xs tabular-nums",
              active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
            )}>
              {t.count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

export default function ModuleView() {
  const { Document } = useDocument();
  const { search } = useLocation();
  const types = Document?.__TYPES__ || [];
  const current = new URLSearchParams(search).get("type") || Document?.__TYPE__;
  const currentType = types.find((t) => t.name === current);

  // "New" creates a document of the active tab's type (the list itself is presented as "Module").
  const primaryAction = currentType && (
    <Link
      variant="default"
      className="text-primary-foreground hover:text-primary-foreground"
      to={`/desk/${currentType.name}/create`}
    >
      <PlusIcon className="pr-1" />
      New {currentType.singular}
    </Link>
  );

  return (
    <EntityList primaryAction={primaryAction}>
      <TypeTabs types={types} current={current} />
    </EntityList>
  );
}
