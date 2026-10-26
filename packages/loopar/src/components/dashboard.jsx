import { useEffect, useState } from "react";
import loopar from "loopar";
import { cn } from "@cn/lib/utils";
import { useDesigner } from "@context/designer-context";
import { DashboardBoard } from "@loopar/components/desk/dashboard-board";

/** Desk page element: a whole Dashboard record, embedded. */
export default function Dashboard(props) {
  const data = props.data || {};
  const { designerMode } = useDesigner();
  const [board, setBoard] = useState(null);

  useEffect(() => {
    if (designerMode || !data.dashboard) return;
    let alive = true;
    loopar.call("Dashboard", "board", { query: { name: data.dashboard }, freeze: false })
      .then(r => alive && setBoard(r || {}))
      .catch(e => alive && setBoard({ issue: e?.message || "Could not load" }));
    return () => { alive = false; };
  }, [data.dashboard, designerMode]);

  if (designerMode) {
    return (
      <div className={cn("w-full rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground", props.className)}>
        Dashboard: {data.dashboard || "pick one in the element editor"}
      </div>
    );
  }

  if (!board) return <div className={cn("w-full p-6 text-sm text-muted-foreground", props.className)}>…</div>;
  if (board.denied) return null;
  if (board.issue) return <div className={cn("w-full p-6 text-sm text-muted-foreground", props.className)}>{board.issue}</div>;

  return (
    <div className={cn("w-full", props.className)}>
      <DashboardBoard
        name={board.name}
        title={data.label || board.name}
        description={loopar.utils.trueValue(data.show_description) ? board.description : null}
        items={board.items}
        link="open"
      />
    </div>
  );
}

Dashboard.dontHaveMetaElements = ["name", "text"];

Dashboard.metaFields = () => [
  {
    group: "content",
    elements: {
      dashboard: { element: SELECT, data: { label: "Dashboard", options: "Dashboard" } },
      show_description: { element: SWITCH, data: { label: "Show description" } },
    },
  },
];
