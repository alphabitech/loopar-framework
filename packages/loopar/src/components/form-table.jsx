import loopar from "loopar";
import BaseInput from "@base-input"
import {MetaComponent} from "@meta-component";
import { isEqual } from "es-toolkit/predicate";

import { useFieldArray, useWatch } from 'react-hook-form';
import { useRowFormulas } from "@@tools/use-formulas";
import { useFormContext } from "@form-context";
import {useRef, useMemo, useCallback, useEffect, memo, useState } from "react";

import { FormWrapper } from "@form-provider";
import { TableProvider, useTable } from "./table/TableContext"

import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@cn/components/ui/button";
import BaseTable from "./table/BaseTable";

import {
  TableCell,
  TableRow,
} from "@cn/components/ui/table";

import { CSS } from '@dnd-kit/utilities';

import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  MouseSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';

const SortableRow = memo(function SortableRow({ index, row, columns }) {
  const { id } = row;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <TableRow 
      ref={setNodeRef} 
      style={style} 
      className="p-0 m-0"
      key={row.id}
    >
      {
        columns.map((col) => {
          const cellProps = col.cellProps || {};
          const { data } = col;

          const draggableProps = col.draggable ? {
            ...listeners,
            ...attributes
          } : {};

          const className = `min-w-40 ${cellProps.className || ""} py-0 px-1`;

          return (
            <TableCell
              key={`${id}-${data.name}-${index}`}
              className={className}
              {...cellProps}
              {...draggableProps}
            >
              {col.render ? col.render(row, index) : row[data.name]}
            </TableCell>
          );
        })
      }
    </TableRow>
  );
});

const MemoizedTableInput = memo(function MemoizedTableInput({ component, cellName, data, register }) {
  return (
    <MetaComponent
      component={component}
      render={(Comp) => (
        <Comp
          dontHaveLabel={true}
          simpleInput={true}
          data={data}
          {...register(cellName)}
        />
      )}
    />
  );
});

const FormTable = (props) => {
  const { selectedRows, bulkRemove, baseColumns, selectorCol, rows } = useTable();
  const { register, move, remove, append } = props;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 5 } }),
    useSensor(MouseSensor, { activationConstraint: { delay: 100, tolerance: 5 } })
  );

  const onDragEnd = useCallback((event) => {
    const { active, over } = event;

    if (active.id !== over.id) {
      const oldIndex = rows.findIndex(f => f.id === active.id);
      const newIndex = rows.findIndex(f => f.id === over.id);
      move(oldIndex, newIndex);
    }
  }, [rows, move]);

  const handleAppend = useCallback(() => {
    append({ id: Date.now(), name: Date.now() });
  }, [append, rows]);

  const handleRemove = useCallback((index) => {
    remove(index);
  }, [remove, rows]);

  const mappedColumns = useMemo(() => {
    const baseCols = baseColumns()
      .filter(col => fieldIsWritable(col) && loopar.utils.trueValue(col.data.in_list_view))
      .map((col) => {
        const newCol = { ...col };
        
        if(newCol.data.name === "name") {
          newCol.data.label = null;
          newCol.cellProps = {
            className: "min-w-40 p-2",
          };
        }
        
        newCol.render = (field, index) => {
          const cellName = `rows.${index}.${newCol.data.name}`;
          return (
            <MemoizedTableInput 
              component={newCol.element}
              cellName={cellName}
              data={{ ...newCol.data, name: cellName, label: newCol.data.label }}
              register={register}
            />
          );
        };
        
        return newCol;
      });

    return [
      selectorCol({
        colSpan: 3,
        deleteOnServer: false
      }),
      {
        data: { name: "index" },
        draggable: true,
        cellProps: {
          className: "min-w-15 max-w-15 p-2 text-center",
        },
        render: (row, idx) => (
          <div 
            className="flex justify-center border-2 rounded-md p-2 drop-shadow-md cursor-move"
          >
            <span>{idx + 1}</span>
          </div>
        ),
      },
      ...baseCols,
      {
        data: {
          name: "actions",
          label: "...",
        },
        headProps: {
          className: "w-10 p-2 text-center",
        },
        cellProps: {
          className: "min-w-10 p-2 text-center",
        },
        render: (row, index) => (
          <Button
            type="button"
            variant="destructive"
            onClick={(e) => {
              e.preventDefault();
              handleRemove(index);
            }}
          >
            <Trash2Icon size={16} />
          </Button>
        ),
      }
    ];
  }, [baseColumns, selectorCol, register, handleRemove]);

  return (
    <div className="feed py-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={rows.map(f => f.id)}
          strategy={verticalListSortingStrategy}
        >
          <BaseTable
            viewType={"List"}
            hasPagination={false}
            hasHeaderOptions={true}
            columns={mappedColumns}
            rowTemplate={SortableRow}
          />
        </SortableContext>
      </DndContext>
      <div className="flex flex-row gap-2">
        {selectedRows.length > 0 && (
          <Button
            type="button"
            variant="destructive"
            onClick={e => {
              e.preventDefault();
              bulkRemove(false);
            }}
          >
            <Trash2Icon className="mr-1" size={16} />
            Remove
          </Button>
        )}
        <Button
          type="button"
          variant="primary"
          onClick={handleAppend}
        >
          <PlusIcon className="mr-1" size={16} />
          Add row
        </Button>
      </div>
    </div>
  )
}

const FormTableControl = ({Document, docRef}) => {
  const form = useFormContext();
  const { control, register } = form;
  const { fields, move, remove, append } = useFieldArray({
    control,
    name: 'rows'
  });

  const rowStructure = useMemo(
    () => loopar.utils.JSONparse(Document?.Entity?.doc_structure, []),
    [Document]
  );
  const watchedRows = useWatch({ control, name: 'rows' });
  useRowFormulas(form, rowStructure, watchedRows);

  return (
    <TableProvider
      initialDocument={Document}
      docRef={docRef}
      rows={fields}
    >
      <FormTable
        register={register} 
        move={move} 
        remove={remove} 
        append={append}
      />
    </TableProvider>
  );
};

const FormTableMiddleware = memo(function FormTableMiddleware(props) {
  const { rows, onChange, meta, docRef } = props;
  const [changes, setChanges] = useState(false);
  const debounceTimer = useRef(null);
  const prevRows = useRef(rows);

  const saveData = useCallback((newRows) => {
    if (!newRows) return;
    newRows.rows = newRows.rows.filter(row => row.id);

    if (!isEqual(newRows.rows, prevRows.current)) {
      prevRows.current = newRows.rows;
      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => onChange(newRows.rows), 300);
    }
  }, [onChange, rows, prevRows]);

  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  useEffect(() => {
    setChanges(changes+1)
  }, [prevRows.current.length]);

  return (
    <FormWrapper __DATA__={{ rows }} onChange={saveData} key={`form-wrapper-${changes}`}>
      <FormTableControl Document={meta} docRef={docRef}/>
    </FormWrapper>
  );
});

export default function FormTableInput(props) {
  const { renderInput } = BaseInput(props);
  const meta = useMemo(() => props.__META__, [props.__META__]);
  const docRef = props.docRef;

  return (
    renderInput(field => {
      const rows = field.value || [];

      const handleChange = useCallback((newRows) => {
        field.onChange({ target: { value: newRows } });
      }, [field]);

      return (
        <FormTableMiddleware
          rows={rows}
          onChange={handleChange}
          meta={meta}
          docRef={docRef}
        />
      );
    })
  );
}
 
FormTableInput.metaFields = ()=>{
  return [
    ...BaseInput.metaFields(),
    [
      {
        group: "form",
        elements: {
          options: {
            element: TEXTAREA,
          },
        },
      }
    ],
  ];
}