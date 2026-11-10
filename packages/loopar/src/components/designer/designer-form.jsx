import {DesignElement} from "./design-element";
import { ELEMENT_GROUPS, paletteDefinition } from "@global/element-definition";
import { useDocument } from "@loopar/document";
import { useWorkspace } from "@workspace/workspace-provider";
import { Input } from "@cn/components/ui/input";
import { ChevronDown } from "lucide-react";
import loopar from "loopar";
import { useId, useMemo, useState } from "react";
import { __ } from "@global/i18n";

const COLLAPSED_KEY = "designer-palette-collapsed";

const readCollapsed = () => {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || {};
  } catch (e) {
    return {};
  }
};

export function DesignerForm() {
  const id = useId();
  const { entity } = useDocument();
  const { __META__ } = useWorkspace();
  const installedApps = __META__?.installed_apps || null;
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleGroup = (group) => {
    setCollapsed(prev => {
      const next = { ...prev, [group]: !prev[group] };
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch (e) {}
      return next;
    });
  };

  const query = search.trim().toLowerCase();

  const groups = useMemo(() => {
    return Object.entries(paletteDefinition(entity, installedApps)).map(([group, elements]) => {
      let visible = elements.filter(el => el.show_in_design !== false);

      if (query) {
        visible = visible.filter(el =>
          el.element.replace(/[_-]/g, " ").toLowerCase().includes(query)
        );
      }

      return { group, elements: visible };
    }).filter(g => g.elements.length > 0);
  }, [entity, query, installedApps]);

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 bg-background dark:bg-background-dark p-2 pb-1">
        <Input
          type="search"
          placeholder={__("Search elements...")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {groups.map(({ group, elements }) => {
        const label = ELEMENT_GROUPS[group]?.label ?? loopar.utils.Capitalize(group);
        const isCollapsed = !query && collapsed[group];

        return (
          <div className="pb-3" key={`${id}-${group}`}>
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-left"
              onClick={() => toggleGroup(group)}
            >
              <h2 className="text-2xl">{label} {__("Elements")}</h2>
              <ChevronDown
                className={`h-5 w-5 text-muted-foreground transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
              />
            </button>
            {!isCollapsed && (
              <div className="grid grid-cols-3 gap-1">
                {elements.map((element) => {
                  return <DesignElement element={element} key={`${id}-${group}-${element.element}`}/>;
                })}
              </div>
            )}
          </div>
        )
      })}
      {query && groups.length === 0 && (
        <p className="p-3 text-sm text-muted-foreground">
          {__("No elements match \"")}{search.trim()}"
        </p>
      )}
    </div>
  );
}
