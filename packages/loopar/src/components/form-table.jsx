import loopar from "loopar";
import BaseInput from "@base-input"
import {MetaComponent} from "@meta-component";
import { isEqual } from "es-toolkit/predicate";

import { useFieldArray, useWatch } from 'react-hook-form';
import { useRowFormulas } from "@@tools/use-formulas";
import { useFormContext, BaseFormContext } from "@form-context";
import {useRef, useMemo, useCallback, useEffect, memo, useState, useContext } from "react";

import { FormWrapper } from "@form-provider";
import { TableProvider, useTable } from "./table/TableContext"

import { PlusIcon, Trash2Icon, PencilIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@cn/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@cn/components/ui/dialog";
import MetaComponents from "@meta-component";
import { cn } from "@cn/lib/utils";
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
import { __ } from "@global/i18n";
import { entityPicker } from "./base/entity-pickers.js";

/** Form values seen from one row: its own cells, as a form of their own. */
function RowValues({ index, children }) {
  const ctx = useContext(BaseFormContext);
  const row = ctx?.values?.rows?.[index];
  const value = useMemo(() => ctx && ({ ...ctx, values: row || {} }), [ctx, row]);
  return <BaseFormContext.Provider value={value}>{children}</BaseFormContext.Provider>;
}

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

const isTrue = (v) => loopar.utils.trueValue(v);

const isEmptyValue = (v) =>
  v === undefined || v === null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "");

/** Required writable fields of the child that the grid does not show: only the row form can fill them. */
function requiredOutsideGrid(structure) {
  const out = [];
  const walk = (nodes = []) => nodes.forEach((el) => {
    if (isTrue(el.data?.hidden)) return;
    if (el.data?.name && fieldIsWritable(el) && isTrue(el.data.required) && !isTrue(el.data.in_list_view)) {
      out.push(el.data.name);
    }
    walk(el.elements);
  });
  walk(structure);
  return out;
}

/** Opens the row form; turns red while a required field outside the grid is empty. */
function EditRowButton({ index, required, onEdit }) {
  const { control } = useFormContext();
  const row = useWatch({ control, name: `rows.${index}` });
  const missing = required.filter((name) => isEmptyValue(row?.[name]));

  return (
    <Button
      type="button"
      variant={missing.length ? "outline" : "secondary"}
      className={cn(missing.length && "border-destructive text-destructive hover:text-destructive")}
      title={missing.length ? __("Missing: {0}", [missing.join(", ")]) : __("Edit row")}
      onClick={(e) => {
        e.preventDefault();
        onEdit(index);
      }}
    >
      <PencilIcon size={16} />
    </Button>
  );
}

/**
 * The child entity's full form for one row (also the fields the grid hides).
 * Works on a copy of the row: Apply validates it with the child's schema and
 * hands the values back; Cancel leaves the row untouched.
 */
function RowEditDialog({ structure, index, count, getRow, onApply, onNavigate, onClose }) {
  const formRef = useRef(null);

  const commit = async () => {
    const api = formRef.current;
    if (!api || !(await api.submit())) return false;   // errors are shown in the form
    // Raw values: the zod output drops keys outside the schema (nested tables, hidden fields).
    onApply(index, api.getValues());
    return true;
  };

  const apply = async () => { if (await commit()) onClose(); };
  const go = async (delta) => { if (await commit()) onNavigate(index + delta); };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{__("Editing row #{0}", [index + 1])}</DialogTitle>
          <DialogDescription>{__("Changes apply to the row; save the document to store them.")}</DialogDescription>
        </DialogHeader>
        <FormWrapper key={index} __DATA__={getRow(index)} STRUCTURE={structure} formRef={formRef}>
          <div className="flex flex-col gap-2">
            {structure.map((el, idx) =>
              !el.element || !el.data || isTrue(el.data.hidden) ? null : (
                <MetaComponents key={el.data?.name ?? idx} elements={[el]} />
              )
            )}
          </div>
        </FormWrapper>
        <DialogFooter className="flex-row items-center gap-2 sm:justify-between">
          <div className="flex gap-1">
            <Button type="button" variant="secondary" size="icon" disabled={index <= 0} title={__("Previous row")} onClick={() => go(-1)}>
              <ChevronLeftIcon size={16} />
            </Button>
            <Button type="button" variant="secondary" size="icon" disabled={index >= count - 1} title={__("Next row")} onClick={() => go(1)}>
              <ChevronRightIcon size={16} />
            </Button>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>{__("Cancel")}</Button>
            <Button type="button" variant="primary" onClick={apply}>{__("Apply")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const FormTable = (props) => {
  const { selectedRows, bulkRemove, baseColumns, selectorCol, rows } = useTable();
  const { register, move, remove, append, form, structure } = props;
  const [editing, setEditing] = useState(null);

  const required = useMemo(() => requiredOutsideGrid(structure), [structure]);

  const getRow = useCallback((index) => form.getValues(`rows.${index}`) || {}, [form]);

  const applyRow = useCallback((index, values) => {
    for (const [key, value] of Object.entries(values || {})) {
      if (key === "id") continue;   // dnd-kit identity of the row
      form.setValue(`rows.${index}.${key}`, value, { shouldDirty: true });
    }
  }, [form]);

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
          const input = (
            <MemoizedTableInput 
              component={newCol.element}
              cellName={cellName}
              data={{ ...newCol.data, name: cellName, label: newCol.data.label }}
              register={register}
            />
          );
          // A cascade (`parent`) reads the other cells of its own row.
          return newCol.data.parent ? <RowValues index={index}>{input}</RowValues> : input;
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
          className: "w-24 p-2 text-center",
        },
        cellProps: {
          className: "min-w-24 p-2 text-center",
        },
        render: (row, index) => (
          <div className="flex justify-center gap-1">
            <EditRowButton index={index} required={required} onEdit={setEditing} />
            <Button
              type="button"
              variant="destructive"
              title={__("Remove row")}
              onClick={(e) => {
                e.preventDefault();
                handleRemove(index);
              }}
            >
              <Trash2Icon size={16} />
            </Button>
          </div>
        ),
      }
    ];
  }, [baseColumns, selectorCol, register, handleRemove, required]);

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
            {__("Remove")}
          </Button>
        )}
        <Button
          type="button"
          variant="primary"
          onClick={handleAppend}
        >
          <PlusIcon className="mr-1" size={16} />
          {__("Add row")}
        </Button>
      </div>
      {editing !== null && editing < rows.length && (
        <RowEditDialog
          structure={structure}
          index={editing}
          count={rows.length}
          getRow={getRow}
          onApply={applyRow}
          onNavigate={setEditing}
          onClose={() => setEditing(null)}
        />
      )}
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
        form={form}
        structure={rowStructure}
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
  // The render callback runs inside the field's Controller, and a read-only
  // record renders the table as a value without calling it: it must not call
  // hooks (the Controller would render fewer hooks). The handler lives here.
  const fieldRef = useRef(null);
  const handleChange = useCallback((newRows) => {
    fieldRef.current?.onChange({ target: { value: newRows } });
  }, []);

  return (
    renderInput(field => {
      const rows = field.value || [];
      fieldRef.current = field;

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
          options: entityPicker({ label: "Child entity", description: "Child table whose rows this field holds." }, "child"),
        },
      }
    ],
  ];
}