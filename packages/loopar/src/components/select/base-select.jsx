import { useState, useEffect, useRef, useCallback, useMemo, useTransition } from "react";
import { CaretSortIcon, CheckIcon, Cross2Icon } from "@radix-ui/react-icons";
import { cn } from "@cn/lib/utils";
import { Button } from "@cn/components/ui/button";
import { invalidClass } from "../input/index.js";
import { Loader2, ArrowUpRight } from "lucide-react";
import { useDialogContext } from "../dialog.jsx";

import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandSeparator,
} from "@cn/components/ui/command";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cn/components/ui/popover";
import { __ } from "@global/i18n";
import { groupOptions } from "./options.js";

const PAGE_SIZE = 20;

export function Select({ 
  search, 
  loadMore,
  pagination = {},
  data, 
  onSelect, 
  options = [], 
  selected = {}, 
  field,
  isLoading = false,
  error = null,
  isLocal = true,
  actions = null,
  openLink = null,
  ...props
}) {
  const [open, setOpen] = useState(false);
  // Text typed in the search box (actions such as "Create «…»" use it).
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(false);
  // Inside a Radix Dialog (Modal / EntryModal) the body gets
  // `pointer-events: none`; the PopoverContent portals to body, so unless the
  // Popover itself runs in modal mode its items render but are inert.
  const { inDialog } = useDialogContext();
  const [currentPage, setCurrentPage] = useState(1);
  const [visibleRows, setVisibleRows] = useState([]);
  const [isPending, startTransition] = useTransition();
  
  const containerRef = useRef(null);
  const observerRef = useRef(null);
  const sentinelRef = useRef(null);
  const isLoadingMoreRef = useRef(false);

  const paginatedRows = useMemo(() => {
    const pages = {};
    for (let i = 0; i < options.length; i += PAGE_SIZE) {
      const pageNumber = Math.floor(i / PAGE_SIZE) + 1;
      pages[pageNumber] = options.slice(i, i + PAGE_SIZE);
    }
    return pages;
  }, [options]);

  const totalLocalPages = useMemo(() => {
    return Math.ceil(options.length / PAGE_SIZE);
  }, [options.length]);

  const hasMore = useMemo(() => {
    if (isLocal) {
      return currentPage < totalLocalPages;
    }
    return pagination.hasMore || false;
  }, [isLocal, currentPage, totalLocalPages, pagination.hasMore]);

  const loadMoreRows = useCallback(async () => {
    if (isLoadingMoreRef.current || isLoading) return;
    
    if (isLocal) {
      if (currentPage < totalLocalPages) {
        startTransition(() => {
          setCurrentPage(prev => prev + 1);
        });
      }
    } else {
      if (pagination.hasMore && loadMore) {
        isLoadingMoreRef.current = true;
        try {
          await loadMore();
        } finally {
          isLoadingMoreRef.current = false;
        }
      }
    }
  }, [isLocal, currentPage, totalLocalPages, pagination.hasMore, loadMore, isLoading]);

  useEffect(() => {
    startTransition(() => {
      setCurrentPage(1);
      setVisibleRows(paginatedRows[1] || []);
    });
  }, [options, paginatedRows]);

  useEffect(() => {
    if (!isLocal || !paginatedRows[currentPage] || !open) return;
    
    startTransition(() => {
      setVisibleRows(prevRows => {
        if (currentPage === 1) {
          return paginatedRows[1] || [];
        }
        
        const newRows = [...prevRows, ...paginatedRows[currentPage]];
        const uniqueRows = Array.from(
          new Map(newRows.map(item => [item?.value, item])).values()
        ).filter(Boolean);
        
        return uniqueRows;
      });
    });
  }, [isLocal, currentPage, open, paginatedRows]);

  useEffect(() => {
    if (isLocal) return;
    setVisibleRows(options);
  }, [isLocal, options]);

  useEffect(() => {
    if (!open || visibleRows.length === 0) return;

    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    const setupObserver = () => {
      if (!sentinelRef.current) return;

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting && hasMore && !isLoading) {
            loadMoreRows();
          }
        },
        {
          root: containerRef.current,
          rootMargin: '100px',
          threshold: 0
        }
      );

      observer.observe(sentinelRef.current);
      observerRef.current = observer;
    };

    const timeoutId = setTimeout(setupObserver, 100);

    return () => {
      clearTimeout(timeoutId);
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, [open, hasMore, visibleRows.length, loadMoreRows, isLoading]);

  const openHandler = useCallback((shouldOpen) => {
    setOpen(shouldOpen);
    
    if (shouldOpen) {
      setQuery("");
      startTransition(() => {
        setCurrentPage(1);
      });
      search(null, false).catch(err => {
        console.error("Search error:", err);
      });
    }
  }, [search]);

  const searchHandler = useCallback((e) => {
    setQuery(e?.target?.value || "");
    startTransition(() => {
      setCurrentPage(1);
    });
    search(e, true).catch(err => {
      console.error("Search error:", err);
    });
  }, [search]);

  const setValueHandler = useCallback((value) => {
    openHandler(false);
    onSelect(value);
  }, [onSelect, openHandler]);

  const clearHandler = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setValueHandler(null);
  }, [setValueHandler]);

  const current = useMemo(() => {
    return selected && typeof selected === "object" && selected.value 
      ? selected 
      : {};
  }, [selected]);

  const renderOption = useMemo(() => {
    if (current.value) {
      if(props.renderOption) return props.renderOption(current)
      return current.formattedValue || current.label || current.value;
    }
    return (
      <span className="truncate text-slate-600/70">
        {__("Select")} {data.label}
      </span>
    );
  }, [current, data.label]);

  const RenderOption = () => {
    if (
      typeof renderOption === "object" && 
      renderOption?.$$typeof !== Symbol.for("react.transitional.element")
    ) {
      return <>{renderOption}</>;
    }
    return renderOption;
  };

  const renderButton = (extraProps = {}) => (
    <Button
      variant="field"
      role="combobox"
      aria-expanded={open}
      aria-label={`Select ${data.label}`}
      className={cn(
        "w-full justify-between pr-1",
        !current.value && "text-muted-foreground",
        field?.isInvalid && invalidClass.border
      )}
      {...extraProps}
    >
      <span className="truncate flex-1 text-left">
        {RenderOption()}
      </span>
      <div className="flex flex-row items-center justify-between ml-2">
        {!data.disabled && current.value && (
          <Cross2Icon
            className={cn(
              "h-5 w-5 shrink-0 transition-opacity",
              active ? "opacity-50" : "opacity-0"
            )}
            onClick={clearHandler}
          />
        )}
        {/* Room for the open link, laid over the button (an <a> can't nest in
            it). Next to the caret, so the hover-only clear (x) appears to its
            left and leaves no gap while hidden. */}
        {link && <span className="w-6 shrink-0" aria-hidden="true" />}
        <CaretSortIcon className="ml-1 h-5 w-5 shrink-0 opacity-50" />
      </div>
    </Button>
  );

  // ↗ to the selected record: a real link (Ctrl/Cmd/middle click → new tab);
  // a plain click calls onOpen (e.g. a modal) when given.
  const link = openLink?.href && current.value ? openLink : null;
  const renderLink = () => link && (
    <a
      href={link.href}
      title={link.label}
      aria-label={link.label}
      onMouseEnter={() => setActive(true)}
      onClick={(e) => {
        e.stopPropagation();
        if (!link.onOpen || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        link.onOpen();
      }}
      className={cn(
        "absolute top-1/2 -translate-y-1/2 z-10 inline-flex h-6 w-6 items-center justify-center rounded",
        "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
        "right-[28px]"
      )}
    >
      <ArrowUpRight className="h-4 w-4" />
    </a>
  );

  const actionItems = (typeof actions === "function" ? actions(query) : actions) || [];

  if (data.disabled) {
    return (
      <div className="relative w-full">
        {renderButton({ disabled: true })}
        {renderLink()}
      </div>
    );
  }

  const showLoading = isLoading && visibleRows.length === 0;
  const showLoadingMore = isLoading && visibleRows.length > 0;

  const paginationInfo = useMemo(() => {
    if (isLocal) {
      return { current: currentPage, total: totalLocalPages };
    }
    return { current: pagination.page || 1, total: pagination.pages || 1 };
  }, [isLocal, currentPage, totalLocalPages, pagination]);

  return (
    <div className="relative w-full">
    <Popover open={open} onOpenChange={openHandler} modal={inDialog}>
      <PopoverTrigger asChild>
        {renderButton({
          onClick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            openHandler(!open);
          },
          onMouseEnter: () => setActive(true),
          onMouseLeave: () => setActive(false),
        })}
      </PopoverTrigger>
      <PopoverContent 
        className="w-full min-w-[var(--radix-popover-trigger-width)] p-0" 
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={`Search ${data.label || props.model}...`}
            className="h-9"
            onKeyUp={searchHandler}
          />
          
          {error && (
            <div className="p-4 text-sm text-destructive">
              {__("Error:")} {error}
            </div>
          )}
          
          {showLoading && (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          
          {!isLoading && !error && visibleRows.length === 0 && (
            // Not CommandEmpty: cmdk hides it while the action items are listed.
            <div className="py-6 text-center text-sm">{__("No results found.")}</div>
          )}
          
          {!error && visibleRows.length > 0 && (
            <div
              className={cn(
                "max-h-[250px] overflow-auto",
                isPending && "opacity-60 transition-opacity"
              )}
              ref={containerRef}
            >
              {groupOptions(visibleRows.filter(Boolean)).map(({ group, options: groupRows }) => (
              <CommandGroup key={group ?? "__"} heading={group || undefined}>
              {groupRows.map((option) => {
                const value = option.formattedValue || option.label || option.value;
                const isSelected = option.value === current.value;

                return (
                  <CommandItem
                    value={String(option.value)}
                    key={option.value}
                    onSelect={() => setValueHandler(option.value)}
                    className={cn(
                      "flex items-center cursor-pointer",
                      isSelected && "bg-accent"
                    )}
                  >
                    <span className="flex-1 truncate">{props.renderOption ? props.renderOption(option) : value}</span>
                    <CheckIcon
                      className={cn(
                        "ml-auto h-4 w-4 shrink-0",
                        isSelected ? "opacity-100" : "opacity-0"
                      )}
                    />
                  </CommandItem>
                );
              })}
              </CommandGroup>
              ))}
              
              {hasMore && (
                <div 
                  ref={sentinelRef} 
                  className="w-full py-2 flex items-center justify-center"
                  style={{ minHeight: '40px' }}
                >
                  {showLoadingMore ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-xs text-muted-foreground">
                        {__("Loading more...")}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {__("Page {0} of {1}", [paginationInfo.current, paginationInfo.total])}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {actionItems.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup>
                {actionItems.map((action) => (
                  <CommandItem
                    key={action.key}
                    value={`__action__${action.key}`}
                    onSelect={() => {
                      openHandler(false);
                      action.onSelect(query);
                    }}
                    className="flex items-center gap-2 cursor-pointer text-muted-foreground"
                  >
                    {action.icon}
                    <span className="truncate">{action.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </Command>
      </PopoverContent>
    </Popover>
    {renderLink()}
    </div>
  );
}