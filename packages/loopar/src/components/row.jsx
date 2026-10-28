import { Droppable } from "@droppable";
import { LayoutSelector, gridLayouts, parseLayout, sameLayout } from "./row/LayoutSelector";
import { ComponentDefaults, DEFAULTS, colPadding } from "./base/ComponentDefaults";
import { useEffect, useState, useRef, useMemo } from "react";
import { cn } from "@cn/lib/utils";
import { RowContextProvider } from "./row/RowContext";
import { useWorkspace } from "@workspace/workspace-provider";
import { useDocument } from "@loopar/document";
import { useDesigner } from "@context/designer-context";
import elementManage from "@@tools/element-manage";

export const STACK_ON = ["never", "sm", "md", "lg"];

const VERTICAL_ALIGN = {
  top: "start",
  center: "center",
  bottom: "end",
  stretch: "stretch",
};

const ROW_HEIGHT = {
  auto: "",
  25: "min-h-[25vh]",
  50: "min-h-[50vh]",
  75: "min-h-[75vh]",
  100: "min-h-screen",
};

// Deterministic key (row key + index) so normalizing the same stored row always
// yields the same tree: a random key made every load produce a different design.
const newCol = (rowKey, index) => ({
  element: "col",
  node: rowKey ? `${rowKey}_c${index}` : elementManage.getUniqueKey(),
  data: {},
});

export default function Row(props) {
  const { setElements, set } = ComponentDefaults(props);
  const data = props.data || {};
  const cols = props.elements || [];
  const { webApp = {} } = useWorkspace();
  const { spacing = {} } = useDocument();
  const { designerMode } = useDesigner();

  const config = useMemo(() => ({
    ...DEFAULTS,
    ...data,
    gap: data.gap ?? spacing.gap ?? webApp.gap ?? DEFAULTS.gap,
    col_padding: data.col_padding || spacing.col_padding || webApp.col_padding || DEFAULTS.col_padding,
  }), [data, spacing, webApp]);

  // --- layout: persisted value is the source of truth; local state only gives
  // instant feedback while `set` debounces the write to the document.
  const persistedLayout = useMemo(() => parseLayout(data.layout), [data.layout]);
  const [layout, setLayout] = useState(persistedLayout);

  useEffect(() => {
    setLayout(prev => (sameLayout(prev, persistedLayout) ? prev : persistedLayout));
  }, [persistedLayout]);

  const handleSetLayout = (next) => {
    if (sameLayout(next, layout)) return;
    setLayout(next);
    set("layout", JSON.stringify(next));
  };

  // --- columns: always exactly layout.length cols. Grows on mount/whenever a
  // col is missing; shrinks only when the *user* changes the layout (never on
  // mount, so opening a legacy document doesn't rewrite it). Extra columns'
  // children are merged into the last surviving column — nothing is lost and
  // undo is available.
  const prevLayoutLenRef = useRef(null);

  useEffect(() => {
    if (!designerMode) return;

    const n = layout.length;
    const prevLen = prevLayoutLenRef.current;
    prevLayoutLenRef.current = n;

    if (cols.length < n) {
      const grown = [...cols];
      while (grown.length < n) grown.push(newCol(props.node ?? props.data?.key, grown.length));
      // First pass (mount / document load): filling the missing cols is a
      // normalization of the stored structure, not a user edit.
      setElements(grown, null, false, { asBase: prevLen == null });
      return;
    }

    if (cols.length > n && prevLen != null && prevLen !== n) {
      const keep = cols.slice(0, n);
      const extra = cols.slice(n);
      const last = keep[n - 1];
      keep[n - 1] = {
        ...last,
        elements: [
          ...(last.elements || []),
          ...extra.flatMap(c => c.elements || []),
        ],
      };
      setElements(keep, null, false);
    }
  }, [layout.length, cols.length, designerMode]);

  const gap = useMemo(() => {
    const sp = parseInt(config.gap);
    return Number.isNaN(sp) ? DEFAULTS.gap : sp;
  }, [config.gap]);

  // `Xfr` distributes the space left after the gap by itself; `minmax(0, …)`
  // keeps wide content (images, code, long words) from breaking the ratio.
  const columnLayout = useMemo(
    () => layout.map(l => `minmax(0, ${l}fr)`).join(" "),
    [layout]
  );

  const stackOn = STACK_ON.includes(config.stack_on) ? config.stack_on : DEFAULTS.stack_on;
  const rowHeight = ROW_HEIGHT[config.full_height ? 100 : config.row_height] || "";
  const verticalAlign = VERTICAL_ALIGN[config.vertical_alignment] || VERTICAL_ALIGN.top;

  return (
    <RowContextProvider
      colPadding={config.col_padding}
      gap={gap}
    >
      {/* Query container: the grid below responds to the row's own width
          (not the viewport), so nested rows stack inside narrow columns. */}
      <div className="@container relative w-full">
        <Droppable
          {...props}
          elements={cols}
          data-stack={stackOn}
          data-reverse={config.reverse_on_mobile ? "true" : undefined}
          className={cn(
            "grid-container dynamic w-full box-border",
            rowHeight,
            data.class,
          )}
          style={{
            "--column-layout": columnLayout,
            "--row-align": verticalAlign,
            gap: `${gap}rem`,
            ...props.style,
          }}
        />
        <LayoutSelector setLayout={handleSetLayout} current={layout} />
      </div>
    </RowContextProvider>
  );
}

Row.metaFields = () => {
  return [
    {
      group: "layout",
      elements: {
        layout: {
          element: SELECT,
          data: {
            label: "Columns",
            options: gridLayouts.map(l => `[${l}]`),
            default_value: `[${DEFAULTS.layout}]`,
          },
        },
        gap: {
          element: SELECT,
          data: {
            label: "Gap",
            options: [0, 1, 2, 3, 4, 5, 6],
            default_value: DEFAULTS.gap,
            description: "Gap between columns in rem.",
          },
        },
        col_padding: {
          element: SELECT,
          data: {
            label: "Column Padding",
            options: colPadding,
            default_value: DEFAULTS.col_padding,
          },
        },
        vertical_alignment: {
          element: SELECT,
          data: {
            label: "Vertical Align",
            options: Object.keys(VERTICAL_ALIGN),
            default_value: DEFAULTS.vertical_alignment,
            description: "How columns align when their heights differ.",
          },
        },
      },
    },
    {
      group: "responsive",
      elements: {
        stack_on: {
          element: SELECT,
          data: {
            label: "Stack Below",
            options: STACK_ON,
            default_value: DEFAULTS.stack_on,
            description: "Columns stack into one when the row is narrower than this size (sm 40rem, md 48rem, lg 64rem).",
          },
        },
        reverse_on_mobile: {
          element: SWITCH,
          data: {
            label: "Reverse When Stacked",
            description: "Show the last column first once columns stack.",
            default_value: DEFAULTS.reverse_on_mobile,
          },
        },
      },
    },
    {
      group: "size",
      elements: {
        row_height: {
          element: SELECT,
          data: {
            label: "Min Height",
            options: Object.keys(ROW_HEIGHT),
            default_value: DEFAULTS.row_height,
            description: "Minimum row height as a share of the viewport.",
          },
        },
      },
    },
  ];
};
