import loopar from "loopar";
import BaseInput from "@base-input"
import {MetaComponent} from "@meta-component";
import { isEqual } from "es-toolkit/predicate";
import { cloneDeep } from "es-toolkit/object";

import { useFieldArray, useWatch } from 'react-hook-form';
import { useRowFormulas } from "@@tools/use-formulas";
import { useFormContext, useFormValues, BaseFormContext } from "@form-context";
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
import { useDocument } from "@loopar/document";

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

/**
 * A new row holding every field of the child (its default, else empty). A
 * key missing from the form values makes react-hook-form fall back to the
 * defaultValues row at the same index — a row deleted before, which would
 * show up again in the new one.
 */
function blankRow(structure) {
  const row = {};
  const walk = (nodes = []) => nodes.forEach((el) => {
    if (el.data?.name && fieldIsWritable(el)) {
      row[el.data.name] = el.element === FORM_TABLE ? [] : (el.data.default_value ?? "");
    }
    walk(el.elements);
  });
  walk(structure);
  return row;
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
 * It edits the row live, like the grid: every change reaches the row at once
 * (only the fields that changed), so the document reacts as it does to the
 * grid — formulas, live pricing filling description, rate, tax… — and what
 * the document fills in the row comes back into this form field by field,
 * keeping what is being typed. Apply validates with the child's schema and
 * closes; Cancel (or closing) puts the row back as it was when opened.
 */
function RowEditDialog({ structure, index, count, form, onApply, onNavigate, onClose, formulaScope }) {
  const formRef = useRef(null);
  // The row as it was when this row's form opened (what Cancel restores), and
  // the row as this form last saw or wrote it (tells its own echo from outside
  // changes). Taken once per row: the table's form object changes on every edit.
  const opened = useRef({ index: null, row: null });
  const known = useRef(null);
  if (opened.current.index !== index) {
    opened.current = { index, row: cloneDeep(form.getValues(`rows.${index}`) || {}) };
    known.current = opened.current.row;
  }
  const snapshot = opened.current.row;

  const row = useWatch({ control: form.control, name: `rows.${index}` });
  // The same row object comes back changed in place: follow its content.
  const rowContent = JSON.stringify(row ?? null);

  // This form → the row.
  const writeThrough = useCallback((values) => {
    if (!values) return;
    known.current = { ...known.current, ...cloneDeep(values) };
    onApply(index, values);
  }, [index, onApply]);

  // The row → this form: only what changed outside since this form last saw it.
  useEffect(() => {
    const inner = formRef.current?.form;
    if (!inner || !row) return;
    const current = inner.getValues();
    for (const [key, value] of Object.entries(row)) {
      if (key === "id" || isEqual(value, known.current?.[key]) || isEqual(value, current[key])) continue;
      inner.setValue(key, value, { shouldDirty: true });
    }
    known.current = { ...known.current, ...cloneDeep(row) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowContent]);

  const validate = async () => {
    const api = formRef.current;
    if (!api || !(await api.submit())) return false;   // errors are shown in the form
    // Raw values: the zod output drops keys outside the schema (nested tables, hidden fields).
    writeThrough(api.getValues());
    return true;
  };

  const apply = async () => { if (await validate()) onClose(); };
  const go = async (delta) => { if (await validate()) onNavigate(index + delta); };
  const cancel = () => { onApply(index, snapshot); onClose(); };

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{__("Editing row #{0}", [index + 1])}</DialogTitle>
          <DialogDescription>{__("Changes apply to the row; save the document to store them.")}</DialogDescription>
        </DialogHeader>
        {/* Same formulas as the grid: references resolve through the parent entity and this table. */}
        <FormWrapper key={index} __DATA__={snapshot} STRUCTURE={structure} formRef={formRef} formulaScope={formulaScope} onChange={writeThrough}>
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
            <Button type="button" variant="secondary" onClick={cancel}>{__("Cancel")}</Button>
            <Button type="button" variant="primary" onClick={apply}>{__("Apply")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const FormTable = (props) => {
  const { selectedRows, setSelectedRows, baseColumns, selectorCol, rows } = useTable();
  const { register, move, remove, append, form, structure, formulaScope } = props;
  const [editing, setEditing] = useState(null);

  const required = useMemo(() => requiredOutsideGrid(structure), [structure]);

  // Only the fields that differ: the row form writes through on every change.
  const applyRow = useCallback((index, values) => {
    const current = form.getValues(`rows.${index}`) || {};
    for (const [key, value] of Object.entries(values || {})) {
      if (key === "id" || isEqual(value, current[key])) continue;   // id: dnd-kit identity of the row
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
    const id = Date.now();
    append({ ...blankRow(structure), id, name: id });
  }, [append, structure]);

  const handleRemove = useCallback((index) => {
    remove(index);
  }, [remove]);

  // The rows live in the form: removing them from the table's own state alone
  // would bring them back with the next render of the form.
  const removeSelected = useCallback(() => {
    const indexes = rows.reduce((acc, row, index) => (selectedRows.includes(row.name) ? [...acc, index] : acc), []);
    if (indexes.length) remove(indexes);
    setSelectedRows([]);
  }, [rows, selectedRows, remove, setSelectedRows]);

  const mappedColumns = useMemo(() => {
    const baseCols = baseColumns()
      .filter(col => fieldIsWritable(col) && loopar.utils.trueValue(col.data.in_list_view))
      .map((col) => {
        const newCol = { ...col };
        
        if(newCol.data.name === "name") {
          // No title, but a header cell all the same: the columns stay aligned.
          newCol.data = { ...newCol.data, label: () => null };
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
              // No help text in the grid (it makes every row tall): the row form shows it.
              data={{ ...newCol.data, name: cellName, label: typeof newCol.data.label === "function" ? null : newCol.data.label, description: "" }}
              register={register}
            />
          );
          // A cascade (`parent`) reads the other cells of its own row.
          return newCol.data.parent ? <RowValues index={index}>{input}</RowValues> : input;
        };
        
        return newCol;
      });

    return [
      selectorCol({ header: "checkbox", deleteOnServer: false }),
      {
        data: { name: "index", label: "#" },
        headProps: { className: "min-w-15 max-w-15 p-2 text-center" },
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
              removeSelected();
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
          form={form}
          onApply={applyRow}
          onNavigate={setEditing}
          onClose={() => setEditing(null)}
          formulaScope={formulaScope}
        />
      )}
    </div>
  )
}

const FormTableControl = ({Document, docRef, table}) => {
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
  // References in the rows' formulas are resolved through the parent entity and this table.
  const parentEntity = docRef?.Document?.Entity?.name ?? null;
  useRowFormulas(form, rowStructure, watchedRows, "rows", { entity: parentEntity, table });
  const formulaScope = useMemo(() => (parentEntity && table ? { entity: parentEntity, table } : null), [parentEntity, table]);

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
        formulaScope={formulaScope}
      />
    </TableProvider>
  );
};

/** A row's identity across the parent and the inner form. */
const rowKey = (row) => String(row?.name ?? row?.id ?? "");

/**
 * Holds the rows in a form of their own and hands them to the parent field
 * (debounced). Changes that come from outside (the document's live pricing
 * filling a description, a rate…) reach the inner form field by field, so
 * what the user is typing in other cells is kept. Only a change of the rows
 * themselves (other rows, the record reloaded, a draft restored) remounts
 * the inner form with the parent's rows.
 */
const FormTableMiddleware = memo(function FormTableMiddleware(props) {
  const { rows, onChange, meta, docRef, table } = props;
  const [version, setVersion] = useState(0);
  const formRef = useRef(null);
  // The rows the parent holds (or is about to). A copy: react-hook-form
  // changes its values in place, which would make every change look known.
  const sent = useRef(cloneDeep(rows));
  const pending = useRef(null);     // { timer, rows } while a change waits for the debounce

  const cancelPending = () => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    pending.current = null;
  };

  const flush = useCallback(() => {
    if (!pending.current) return;
    const next = pending.current.rows;
    cancelPending();
    onChange(next);
  }, [onChange]);

  const saveData = useCallback((values) => {
    const next = (values?.rows || []).filter((row) => row?.id);
    if (isEqual(next, sent.current)) {
      // Back to what the parent holds (an outside change applied here): an
      // older change still waiting would overwrite it.
      cancelPending();
      return;
    }
    sent.current = cloneDeep(next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { rows: next, timer: setTimeout(flush, 300) };
  }, [flush]);

  // A change still in the debounce reaches the parent even if the table goes away.
  useEffect(() => () => flush(), [flush]);

  useEffect(() => {
    if (isEqual(rows, sent.current)) return;
    const before = sent.current || [];
    const inner = formRef.current?.form;
    const current = inner?.getValues("rows") || [];
    const sameRows = !!inner && rows.length === current.length
      && rows.every((row, i) => rowKey(row) === rowKey(current[i]));

    if (sameRows) {
      // Only what changed outside goes in: the cells being edited keep their value.
      rows.forEach((row, i) => {
        for (const [key, value] of Object.entries(row || {})) {
          if (key === "id" || isEqual(value, before[i]?.[key]) || isEqual(value, current[i]?.[key])) continue;
          inner.setValue(`rows.${i}.${key}`, value, { shouldDirty: true });
        }
      });
      sent.current = cloneDeep(rows);
      return;
    }

    cancelPending();
    sent.current = cloneDeep(rows);
    setVersion((v) => v + 1);
  }, [rows]);

  return (
    <FormWrapper __DATA__={{ rows }} onChange={saveData} formRef={formRef} key={`form-wrapper-${version}`}>
      <FormTableControl Document={meta} docRef={docRef} table={table}/>
    </FormWrapper>
  );
});

export default function FormTableInput(props) {
  const { renderInput } = BaseInput(props);
  const meta = useMemo(() => props.__META__, [props.__META__]);
  // The document this table belongs to: MetaRender does not hand docRef to
  // components, and the rows resolve their formula references through it.
  const { docRef } = useDocument() || {};
  // The render callback runs inside the field's Controller, and a read-only
  // record renders the table as a value without calling it: it must not call
  // hooks (the Controller would render fewer hooks). The handler lives here.
  const fieldRef = useRef(null);
  const handleChange = useCallback((newRows) => {
    fieldRef.current?.onChange({ target: { value: newRows } });
  }, []);

  // The parent form's live value: the field's Controller only follows changes
  // of the whole array, not one cell set from outside (`lines.2.description`
  // filled by live pricing), which the table must see too.
  const live = useFormValues()?.[props.data?.name];
  // react-hook-form changes its values in place: the same array comes back
  // with other cells. A copy per content, so the table sees every change.
  const liveKey = Array.isArray(live) ? JSON.stringify(live) : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const liveRows = useMemo(() => (liveKey === null ? null : cloneDeep(live)), [liveKey]);

  return (
    renderInput(field => {
      const rows = (Array.isArray(liveRows) ? liveRows : field.value) || [];
      fieldRef.current = field;

      return (
        <FormTableMiddleware
          rows={rows}
          onChange={handleChange}
          meta={meta}
          docRef={docRef}
          table={props.data?.name}
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