import { Fragment } from "react";
import { Pagination } from "@pagination";
import loopar from "loopar";
import { Link } from "@link";
import { Checkbox } from "@cn/components/ui/checkbox";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@cn/components/ui/card";

import { Avatar, AvatarFallback } from "@cn/components/ui/avatar";
import { Badge } from "@cn/components/ui/badge";
import { useTable } from "./TableContext"
import { useViewOptions } from "@loopar/document";
import { TableSearch } from "./TableSearch";
import { EmptyTable } from "./EmptyTable";
import { DropdownListGridActions } from "./DropdownListGridActions";

import {
  PencilIcon,
  Trash2Icon,
} from "lucide-react";

export function GridView(props) {
  const {
    selectedRows,
    selectRow,
    search,
    docRef,
    deleteRow,
  } = useTable();

  const { hasSearchForm, hasSelectAll, gridTemplate } = useViewOptions();

  const rows = props.rows || useTable().rows || [];

  const defaultAction = (row) => {
    if (["Entity", "Builder", "Contact Form Builder"].includes(row.type || "")) {
      return row.is_single ? "update" : "list";
    }
    if (["Page Builder", "View Builder"].includes(row.type)) return "view";
    return "";
  };

  return (
    <>
      <div className="flex gap-2">
        {hasSelectAll !== false && <DropdownListGridActions deleteOnServer={true}/>}
        {hasSearchForm !== false && <TableSearch onChange={search} />}
      </div>
      <div>
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]">
          {rows.length ? rows.map((row) => {
            const action = defaultAction(row);
            const color = loopar.bgColor(row.name);
            return gridTemplate ? (
              <Fragment key={row.name}>{gridTemplate(row, action)}</Fragment>
            ) : (
              <div key={row.name}>
                <Card className="w-full min-w-[300px]">
                  <CardHeader>
                  <CardDescription>
                    <div className='items-center flex gap-2'>
                      <Checkbox
                        className="h-4 w-4"
                        onCheckedChange={(event) => {
                          selectRow(row, event);
                        }}
                        checked={selectedRows.includes(row.name)}
                      />
                      <Badge variant="secondary" className="bg-secondary text-white">
                        {row.type}
                      </Badge>
                    </div>
                  </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-3">
                      <Avatar
                        className="rounded-3 h-14 w-14"
                        style={{ backgroundColor: color }}
                      >
                        <AvatarFallback className="bg-transparent text-2xl font-bold">
                          {loopar.utils.avatar(row.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <h4>{row.name}</h4>
                        <h6 className="font-bold text-slate-500 dark:text-slate-400">
                          {row.module}
                        </h6>
                      </div>
                    </div>
                  </CardContent>
                  <CardFooter className="flex justify-between">
                    <Link
                      variant="outline"
                      to="delete"
                      onClick={(e) => {
                        e.preventDefault();
                        deleteRow(row, true);
                      }}
                    >
                      <Trash2Icon className="mr-2" />
                      Delete
                    </Link>
                    <Link variant="outline" to={`update?name=${row.name}`}>
                      <PencilIcon className="mr-2" />
                      Update
                    </Link>
                  </CardFooter>
                </Card>
              </div>
            );
          }) : (
            <div className="col-span-full flex w-full items-center justify-center p-4">
              <EmptyTable />
            </div>
          )}
        </div>
      </div>
      <div className="mt-3">
        <Pagination/>
        {props.footer}
      </div>
    </>
  );
}