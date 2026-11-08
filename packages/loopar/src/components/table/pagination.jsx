import { Button } from "@cn/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useId } from "react";
import { useTable } from "./TableContext"
import { __ } from "@global/i18n";

export function Pagination() {
  const { pagination, setPage } = useTable();

  const getPages = () => {
    const { page, totalPages } = pagination;
    const maxPagesToShow = 5;
    const pages = [];

    if (totalPages <= maxPagesToShow) {
      return new Array(totalPages).fill().map((_, i) => i + 1);
    } else {
      const halfMaxPagesToShow = Math.floor(maxPagesToShow / 2);
      let startPage = page - halfMaxPagesToShow;
      let endPage = page + halfMaxPagesToShow;

      if (startPage <= 0) {
        endPage = maxPagesToShow;
        startPage = 1;
      } else if (endPage > totalPages) {
        endPage = totalPages;
        startPage = totalPages - maxPagesToShow + 1;
      }

      if (startPage > 1) {
        pages.push(1);
        startPage > 2 && pages.push("...");
      }

      for (let i = startPage; i <= endPage; i++) {
        pages.push(i);
      }

      if (endPage < totalPages) {
        endPage < totalPages - 1 && pages.push("...");
        pages.push(totalPages);
      }

      return pages;
    }
  }

  const { page, pageSize, totalRecords, totalPages } = pagination;

  const initial = (page - 1) * pageSize + 1;
  const final = page * pageSize > totalRecords ? totalRecords : page * pageSize;

  return (
    <div className="flex-col-2 justify-content flex flex-row border bg-slate-100/80 py-2 pr-2 dark:bg-slate-900/60">
      <div className="w-full p-3 pt-4">
        {__("Showing {0} to {1} of {2} entries", [initial, final, totalRecords])}
      </div>
      <div className="w-full">
        <ul
          className="flex flex-row justify-end gap-1"
        >
          <li
            className={`${totalPages <= 1 || page === 1 ? "disabled" : ""}`}
            key={useId()}
          >
            <Button
              variant="ghost"
              onClick={() => {
                setPage(page - 1);
              }}
            >
              <ChevronLeftIcon />
            </Button>
          </li>
          {getPages().map((p, i) => {
            return (
              <Button
                key={`${p}-${i}`}
                onClick={() => p !== "..." && setPage(p)}
                variant={p === page ? "destructive" : "ghost"}
              >{p}</Button>
            );
          })}
          <li
            className={`${page >= totalPages || totalPages <= 1 ? "disabled" : ""}`}
          >
            <Button
              variant="ghost"
              onClick={() => {
                setPage(page + 1);
              }}
            >
              <ChevronRightIcon />
            </Button>
          </li>
        </ul>
      </div>
    </div>
  );
}