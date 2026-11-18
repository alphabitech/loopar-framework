import {
  createContext,
  useState,
  useEffect,
  useContext,
  useMemo,
  useId,
  useRef
} from "react";

import elementManage from "@@tools/element-manage";
import loopar, {useRealtime} from "loopar";
import { DropdownListGridActions } from "./DropdownListGridActions";
import { Checkbox } from "@cn/components/ui/checkbox";
import Emitter from '@services/emitter/emitter';
import { useWorkspace } from "@workspace/workspace-provider";
import { LIST_SETTING_ENTITY, normalizeListSettings, formatSort, resolveListColumns } from "@global/list-settings";
import { REPORT_PARAMS } from "@global/list-report";
import { downloadText } from "./list-url";

const TableContext = createContext();

export const useTable = () => useContext(TableContext);

export const TableProvider = ({
  initialDocument,
  docRef = {},
  hasSearchForm = false,
  viewType: _viewType,
  isEditable,
  onDeleteRow,
  children,
  ...props
}) => {
  const [Document, setDocument] = useState(initialDocument || {});
  const [selectedRows, setSelectedRows] = useState([]);
  const [pagination, setPagination] = useState(initialDocument?.pagination || {});
  const { pathname: currentUrl, navigate, refresh } = useWorkspace();

  useEffect(() => {
    setPagination(initialDocument?.pagination || {});
  }, [initialDocument?.pagination]);

  /**
   * List state lives in the URL (`?status=Open&page=2`): searching or paging
   * navigates, and the workspace fetches the data for the new URL. Links can
   * be shared, reloaded and walked with back/forward.
   */
  const urlWith = (mutate) => {
    const [path, query = ""] = String(currentUrl || "").split("?");
    const params = new URLSearchParams(query);
    mutate(params);
    const next = params.toString();
    return next ? `${path}?${next}` : path;
  };

  const sameUrl = (a, b) => {
    const [pa, qa = ""] = String(a || "").split("?");
    const [pb, qb = ""] = String(b || "").split("?");
    return pa === pb && new URLSearchParams(qa).toString() === new URLSearchParams(qb).toString();
  };

  const setPage = (page) => {
    const next = urlWith(params => page > 1 ? params.set("page", String(page)) : params.delete("page"));
    if (!sameUrl(next, currentUrl)) navigate(next);
  };

  // Only a server list (it has pagination) sorts and keeps per-user settings;
  // a form table holds local rows.
  const isServerList = !!initialDocument?.pagination;

  /**
   * The user's settings for this list (global/list-settings.js): column
   * order, hidden / extra columns, widths and sort. They come with the list
   * and are saved as the user changes them.
   */
  const incomingSettings = JSON.stringify(initialDocument?.list_settings ?? null);
  const [listSettings, setListSettings] = useState(() => normalizeListSettings(initialDocument?.list_settings));
  const settingsRef = useRef(listSettings);

  useEffect(() => {
    const next = normalizeListSettings(initialDocument?.list_settings);
    settingsRef.current = next;
    setListSettings(next);
  }, [incomingSettings]);

  /** Applies `patch` now and saves it; `reload` fetches the list again afterwards (new columns need their data). */
  const saveListSettings = async (patch, { reload = false } = {}) => {
    const next = normalizeListSettings({ ...settingsRef.current, ...patch });
    settingsRef.current = next;
    setListSettings(next);
    try {
      // Background save: no screen freeze, no error toast.
      await loopar.call(LIST_SETTING_ENTITY, "save", {
        body: { entity: Document.Entity?.name, settings: next },
        freeze: false,
        notifyError: false,
      });
    } catch (e) {
      // Not saved (e.g. the app is not updated yet): the change still applies to this view.
      console.warn("[list] settings not saved:", e?.message || e);
    }
    if (reload) refresh();
    return next;
  };

  // Order of the list as the server applied it: `[{ field, dir }]`, first criterion first.
  const sort = Array.isArray(pagination?.sort) ? pagination.sort : [];

  /**
   * Header click: the column cycles ascending → descending → not sorted
   * within the current sort, so columns add up in the order they are clicked
   * (sort by plan, then by status) and each one leaves on its own. `only`
   * (shift+click) sorts by that column alone. Saved for the user and written
   * to the URL (`?sort=plan,-status`). Always back to page 1.
   */
  const toggleSort = async (field, only = false) => {
    const current = sort.find((s) => s.field === field);
    const cycled = !current ? { field, dir: "asc" } : current.dir === "asc" ? { field, dir: "desc" } : null;

    let nextSort;
    if (only) {
      nextSort = [sort.length === 1 && cycled ? cycled : { field, dir: "asc" }];
    } else {
      nextSort = !current
        ? [...sort, cycled]
        : sort.flatMap((s) => (s.field === field ? (cycled ? [cycled] : []) : [s]));
    }

    // Saved first: without `?sort=` the server falls back to the saved sort.
    await saveListSettings({ sort: nextSort });

    const next = urlWith(params => {
      nextSort.length ? params.set("sort", formatSort(nextSort)) : params.delete("sort");
      params.delete("page");
    });
    sameUrl(next, currentUrl) ? refresh() : navigate(next);
  };

  const [rows, setRows] = useState(props.rows || []);
  const tableId = useId();
  const rowRefs = useRef({});

  useEffect(() => {
    setRows(props.rows || []);
  }, [props.rows]);

  // Only a server list (it has pagination) reloads; a form table holds local rows.
  useRealtime(`${Document.Entity?.name}.changed`, () => {
    if (isServerList) refresh();
  });

  useEffect(() => {
    setDocument(initialDocument || {});
  }, [initialDocument]);

  const baseColumns = useMemo(() => {
    if (!Document) return [];
    const parseElements = (elements = []) =>
      elements
        .map((el) => [{ ...el }, ...parseElements(el.elements || [])])
        .flat();
    const STRUCTURE = loopar.utils.JSONparse(Document.Entity?.doc_structure, []);
    return parseElements(STRUCTURE);
  }, [Document.Entity]);

  const selectRow = (row, checked) => {
    setSelectedRows((prevSelected) =>
      checked
        ? Array.from(new Set([...prevSelected, row.name]))
        : prevSelected.filter((r) => r !== row.name)
    );

    Emitter.emit("onSelect", {
      row,
      checked
    });
  };

  const toggleRowSelect = (row) => {
    const rowName = row.name;
    const rowIndex = selectedRows.indexOf(rowName);
    selectRow(row, rowIndex === -1);
  }

  const addRow = () => {
    const newRows =  [...rows]
    const maxId = loopar.utils.getArrayMax(newRows, "id") || 0;

    newRows.push({ id: maxId + 1, name: elementManage.uuid() });
    setRows(newRows);
  }

  const selectAllVisibleRows = (checked = true) => {
    const allNames = (rows || []).map((r) => r.name);
    setSelectedRows(checked ? allNames : []);
  };

  /** `values`: `{ field: value }`; null/empty removes the filter. Always back to page 1. */
  const search = (values = {}) => {
    const next = urlWith(params => {
      for (const [key, value] of Object.entries(values || {})) {
        const v = value == null ? "" : String(value).trim();
        v === "" ? params.delete(key) : params.set(key, v);
      }
      params.delete("page");
    });
    // Typing refines the same search: replace, don't stack history entries.
    if (!sameUrl(next, currentUrl)) navigate(next, { replace: true });
  };

  const rowsCount = useMemo(() => rows.length, [rows]);
  const selectedCount = useMemo(() => selectedRows.length, [selectedRows]);

  const selectorAllStatus = useMemo(() => {
    if (rowsCount > 0 && selectedCount > 0 && selectedCount < rowsCount) {
      return "indeterminate";
    } else if (rowsCount > 0 && selectedCount === rowsCount) {
      return true;
    }
    return false;
  }, [rowsCount, selectedCount]);

  const deleteOnServer = async (row) => {
    loopar.confirm(`Are you sure you want to delete ${row.name}?`, async () => {
      await loopar.call(Document.Entity.name, "delete", {
        query: { name: row.name },
      });
    })
  }

  const deleteRow = (row, onServer=false) => {
    if (!row) return;
    if (onServer) return deleteOnServer(row);

    const rowName = row.name;
    const rowIndex = selectedRows.indexOf(rowName);
    if (rowIndex > -1) {
      setSelectedRows((prev) => prev.filter((r) => r !== rowName));
    }
    setRows((prev) => prev.filter((r) => r.name !== row.name));
    onDeleteRow && onDeleteRow();
  };

  const bulkRemove = (onServer=false) => {
    if (!selectedRows.length) {
      return loopar.dialog({
        type: "alert",
        title: "Warning",
        message: "Please select at least one row to delete.",
      });
    }

    if(onServer) return bulkRemoveOnServer();
    setRows((prev) => prev.filter((r) => !selectedRows.includes(r.name)));
    setSelectedRows([]);
    onDeleteRow && onDeleteRow();
  };

  const bulkRemoveOnServer = () =>{
    loopar.confirm(
      `Are you sure you want to delete [${selectedRows.join(", ")}] ${Document.Entity?.name || "documents"}?`,
      async () => {
        await loopar.call(Document.Entity.name, "bulkDelete", {
          body: { names: selectedRows },
        });
      },
    )
  }

  /**
   * Downloads the list as CSV (`{Entity}/export`): the selected records, or
   * every record the list's filters match; the columns the user sees, in
   * their order, sorted as the list is.
   */
  const exportCsv = async () => {
    const params = new URLSearchParams(String(currentUrl || "").split("?")[1] || "");
    ["page", "preloaded", "workspace", ...REPORT_PARAMS].forEach((key) => params.delete(key));
    const fields = resolveListColumns(baseColumns, settingsRef.current).map((col) => col.data.name);

    const result = await loopar.call(Document.Entity.name, "export", {
      query: Object.fromEntries(params),
      body: { fields, ...(selectedRows.length ? { names: selectedRows } : {}) },
    });
    if (!result?.csv) return;
    downloadText(result.filename || "export.csv", result.csv);
    if (result.truncated) {
      loopar.notify(`The export holds the first ${result.rows} records. Add filters to export the rest.`, "warn");
    }
  };

  /**
   * Row checkbox column. Its header holds the select-all menu and may span the
   * next columns (`colSpan`, for columns without a title). `header: false`
   * leaves the header empty: the view shows the menu elsewhere (its toolbar).
   */
  const selectorCol = ({ colSpan, deleteOnServer, header = true }={}) => {
    return {
      data: {
        name: "selector",
        label: () => header
          ? <DropdownListGridActions deleteOnServer={deleteOnServer}/>
          : null,
      },
      headProps: {
        className: "w-10 p-2",
        colSpan: colSpan || 2
      },
      // `!px-2`: the base TableCell drops the right padding of a cell holding a
      // checkbox, which pushes it off-center.
      cellProps: {
        className: "align-middle w-10 !px-2 py-2"
      },
      render: (row) => (
        <div className="flex items-center justify-center">
          <Checkbox
            onCheckedChange={(event) => {
              selectRow(row, event);
            }}
            checked={selectedRows.includes(row.name)}
          />
        </div>
      ),
    }
  };

  const tableContextValue = {
    Document,
    rows,
    setRows,
    setDocument,
    addRow,
    toggleRowSelect,
    selectedRows,
    setSelectedRows,
    docRef,
    rowsCount,
    selectedCount,
    selectorAllStatus,
    selectorCol,
    tableId,
    rowRefs,
    pagination,
    setPage,
    sort,
    toggleSort: isServerList ? toggleSort : null,
    listSettings,
    saveListSettings: isServerList ? saveListSettings : null,
    exportCsv: isServerList ? exportCsv : null,
    baseColumns: () => [
      ...baseColumns,
      {
        className: "align-middle text-right",
        rowsProps: {
          className: "align-middle text-right",
        },
        cellProps: {
          style: { width: 50 },
          className: "align-middle text-center",
        },
        isCustom: true,
        data: {
          name: "actions",
          label: "",
          value: (row) => {
            return (
              <Button
                variant="outline"
                onClick={(e) => {
                  e.preventDefault();
                  deleteRow(row);
                }}
              >
                <TrashIcon className="text-red-500" />
              </Button>
            );
          },
        },
      }
    ],
    selectRow,
    selectAllVisibleRows,
    search,
    deleteRow,
    bulkRemove,
  };

  return (
    <TableContext.Provider value={tableContextValue}>
      {children}
    </TableContext.Provider>
  );
};

export default TableContext;
