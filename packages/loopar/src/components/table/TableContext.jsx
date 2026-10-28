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

  const [rows, setRows] = useState(props.rows || []);
  const tableId = useId();
  const rowRefs = useRef({});

  useEffect(() => {
    setRows(props.rows || []);
  }, [props.rows]);

  // Only a server list (it has pagination) reloads; a form table holds local rows.
  useRealtime(`${Document.Entity?.name}.changed`, () => {
    if (initialDocument?.pagination) refresh();
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

  const selectorCol = ({ colSpan, deleteOnServer }={}) => {
    return {
      data: {
        name: "selector",
        label: () => (
          <DropdownListGridActions deleteOnServer={deleteOnServer}/>
        ),
      },
      headProps: {
        className: "w-10 p-2",
        colSpan: colSpan || 2
      },
      cellProps: {
        className: "align-middle text-truncate w-10 px-4 py-2"
      },
      render: (row) => (
        <Checkbox
          onCheckedChange={(event) => {
            selectRow(row, event);
          }}
          checked={selectedRows.includes(row.name)}
        />
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
