import { useTable } from "./TableContext.jsx";
import { Pagination } from "./pagination.jsx";

import {SimpleTable} from "./SimpleTable.jsx";
function BaseTable(props) {
  const {rows} = useTable();

  return (
    <div className="flex flex-col gap-2">
      <div className="border">
        <SimpleTable
          rows={rows}
          columns={props.columns}
          footer={props.footer}
          rowTemplate={props.rowTemplate}
          onResize={props.onResize}
          onReorder={props.onReorder}
        />
      </div>
      <div className="">
        {props.hasPagination && <Pagination />}
        {props.footer}
      </div>
    </div>
  );
}

export default BaseTable;