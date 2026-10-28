import loopar from "loopar";
import { BrushIcon, BracesIcon, EyeIcon, SparkleIcon, HandGrab, BrushCleaning, Undo2, Redo2 } from "lucide-react";
import { BaseFormContext } from "@form-provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DesignerContext, useDesigner } from "@context/designer-context";
import {Button} from "@cn/components/ui/button";
import Tab from "@tab";
import Tabs from "@tabs";
import {usePersist} from "@services/persist-state";
import {cn} from "@cn/lib/utils";
import { isEqual } from "es-toolkit/predicate";
import { Sidebar } from "./sidebar";
import {useDocument} from "@loopar/document";
import elementManage from "@@tools/element-manage";
import {DragAndDropProvider} from "../droppable/DragAndDropContext.jsx";
import {Prompt} from "./src/prompt/Prompt.jsx";
import MarkdownPreview from '@uiw/react-markdown-preview';
import {elementsNames} from "@global/element-definition";
import {OrphanColumnsManager} from "./src/OrphanColumnsManager.jsx"
import { ElementStore, ElementStoreContext } from "./element-store.js";
import { getNodeKey, pruneDocStructure } from "@global/prune-doc-structure";
import Emitter from "@services/emitter/emitter";

const updateE = (structure, data, node, merge) => {
  return structure.map((el) => {
    if (!el.data) return el;

    const newEl = {...el, data: {...el.data}};

    if (!elementsNames.includes(newEl.element)) {
      newEl.data.tag = newEl.element;
      newEl.element = "generic";
    }

    if (getNodeKey(newEl) === node) {
      const { key: _stripK, id: _stripI, ...incoming } = data || {};
      newEl.data = merge ? {...newEl.data, ...incoming} : {...incoming};
      newEl.node ??= elementManage.getUniqueKey();
    } else {
      newEl.elements = updateE(newEl.elements || [], data, node, merge);
    }

    return newEl;
  });
};

// Walks the meta tree and fills in missing data fields (key/id/label/name).
// Preserves structural sharing: if a node and its descendants don't need any
// changes, the same reference is returned. This keeps React from re-rendering
// the entire designer on every drop — only the path from root to the touched
// nodes gets new identities.
const fixMeta = (structure, path = "") => {
  try {
    let arrChanged = false;
    const result = structure.map((el, idx) => {
      const data = el.data || {};
      const writable = fieldIsWritable(el);
      // Do NOT use getNodeKey here: its fallback returns a RANDOM key, which
      // made fixMeta non-deterministic for keyless nodes (different keys on
      // every render/load -> SSR hydration mismatches and a base hash that
      // never matched the saved draft's).
      const currentKey = el.node ?? el.key ?? el.data?.key ?? null;
      // Deterministic fallback: derived from the node's position/content so
      // the same server meta always yields the same generated keys.
      const finalKey = currentKey || ("gk" + hashStr(`${path}/${idx}:${el.element}:${data.name || ""}`).replace("-", "n"));
      const needsKeyAtNode = el.node !== finalKey;
      const needsIdMirror = data.id == null;
      const needsLabel = writable && data.label == null;
      const needsName = writable && data.name == null;
      const dataChanged = needsIdMirror || needsLabel || needsName || el.data == null;
      const hasChildren = Array.isArray(el.elements) && el.elements.length > 0;
      const newChildren = hasChildren ? fixMeta(el.elements, `${path}/${idx}`) : el.elements;
      const childrenChanged = newChildren !== el.elements;

      if (!needsKeyAtNode && !dataChanged && !childrenChanged) return el;

      arrChanged = true;

      let newData = data;
      if (dataChanged) {
        newData = { ...data};
        if (newData.id == null) newData.id = finalKey;
        if (writable) {
          newData.label ??= loopar.utils.Capitalize((newData.name || finalKey).replaceAll("_", " "));
          newData.name ??= finalKey;
        }
      }

      const out = { ...el, node: finalKey, data: newData };

      if (newChildren === undefined) delete out.elements;
      else out.elements = newChildren;
      return out;
    });
    return arrChanged ? result : structure;
  } catch (error) {
    loopar.throw(error);
  }
}

const hashStr = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
};

const DesignerButton = () => {
  const { designerMode, designerModeType } = useDesigner();
  const { sidebarOpen, name } = useDocument();

  if (!designerMode || designerModeType == "preview") {
    return <><BrushIcon className="mr-2" /> Design</>
  }

  if (designerModeType == "editor") {
    if (sidebarOpen) {
      return <><BrushIcon className="mr-2" /> Design</>
    } else {
      return <><EyeIcon className="mr-2" /> Preview</>
    }
  }

  if (designerModeType == "designer") {
    return <><EyeIcon className="mr-2" /> Preview</>
  }
}

export const BaseDesigner = (props) => {
  const {data, node, metaComponents} = props;
  const [activeId] = useState(null);
  const {designerMode} = useDesigner();
  const {name, entity, sidebarOpen, handleSetSidebarOpen} = useDocument();
  const [dragEnabled, setDragEnable] = useState(true);

  const [updatingElementName, setUpdatingElementName] = usePersist(name + "updatingElementName");
  const [designerModeType, setDesignerModeType] = usePersist(name + "designer-mode-type");
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const [currentPrompt, setCurrentPrompt] = useState("Generate a form that allows me to manage inventory data");
  const [updatingFromEditor, setUpdatingFromEditor] = useState(false);
  const selfKey = node || data.key;

  // Scoped by entity AND record: new records have no name, so a key without the
  // entity made every unsaved design (Page, Form, Print Format…) share one
  // draft. A new record keeps one draft per entity ("__new__").
  const draftKey = `loopar-designer-draft:${entity || ""}:${name || "__new__"}:${selfKey}`;
  const readDraft = () => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(draftKey);
      const d = raw ? JSON.parse(raw) : null;
      return (d && Array.isArray(d.meta)) ? d : null;
    } catch { return null; }
  };

  const serverBaseHashRef = useRef(null);
  // Hashes of the JSON this designer itself emitted through onChange. The
  // parent (designer.jsx) feeds field.value straight back as metaComponents,
  // so every edit ECHOES into the prop — those echoes must never be mistaken
  // for a server-content change (that reset state and deleted the draft).
  const emittedHashesRef = useRef(new Set());
  const rememberEmitted = useCallback((json) => {
    const s = emittedHashesRef.current;
    s.add(hashStr(json));
    if (s.size > 20) s.delete(s.values().next().value);
  }, []);

  // IMPORTANT: the first client render must match the server, and the server
  // never has localStorage. So we ALWAYS seed from the server base here and
  // defer any draft restore to a mount effect below. Reading the draft in this
  // initializer is exactly what caused the SSR hydration mismatch (server =
  // base, client = restored draft → divergent undo state, gallery slides, etc.).
  const [localMetaComponents, setLocalMetaComponents] = useState(() => {
    const base = fixMeta(metaComponents || []);
    // Hash the RAW server meta (not the fixMeta'd tree): deterministic by
    // construction and immune to anything fixMeta fills in.
    serverBaseHashRef.current = hashStr(JSON.stringify(metaComponents || []));
    return base;
  });
  const commitTimerRef = useRef(null);
  const storeRef = useRef(null);

  const historyRef = useRef(null);
  if (storeRef.current === null) {
    storeRef.current = new ElementStore();
    const base = fixMeta(metaComponents || []);
    storeRef.current.populate(base);
    const baseJson = JSON.stringify(storeRef.current.reconcileTree(base));
    historyRef.current = { stack: [baseJson], index: 0 };
  }

  // Draft UX state — client-only, both start false so SSR and the first client
  // render agree. `hasUnsavedChanges` drives the "unsaved" badge; `draftConflict`
  // surfaces a stale draft whose base no longer matches the server.
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const conflictDraftRef = useRef(null);
  const draftHandledRef = useRef(false);

  const [canUndo, setCanUndo] = useState(() => historyRef.current.index > 0);
  const [canRedo, setCanRedo] = useState(() => historyRef.current.index < historyRef.current.stack.length - 1);
  const syncHistory = useCallback(() => {
    const h = historyRef.current;
    setCanUndo(h.index > 0);
    setCanRedo(h.index < h.stack.length - 1);
  }, []);

  const stateRef = useRef({});
  stateRef.current.localMetaComponents = localMetaComponents;
  stateRef.current.updatingElementName = updatingElementName;
  stateRef.current.designerModeType = designerModeType;
  stateRef.current.sidebarOpen = sidebarOpen;
  stateRef.current.selfKey = selfKey;
  stateRef.current.onChange = props.onChange;
  stateRef.current.handleSetSidebarOpen = handleSetSidebarOpen;
  stateRef.current.setUpdatingElementName = setUpdatingElementName;
  stateRef.current.setDesignerModeType = setDesignerModeType;

  // Apply a saved draft AFTER mount (never during the first render — see the
  // localMetaComponents initializer). Also reused by "restore anyway" on a
  // conflicting draft.
  const applyDraft = useCallback((draftMeta) => {
    const restored = fixMeta(draftMeta);
    storeRef.current.populate(restored);
    const draftJson = JSON.stringify(storeRef.current.reconcileTree(restored));
    historyRef.current = { stack: [historyRef.current.stack[0], draftJson], index: 1 };
    setLocalMetaComponents(restored);
    syncHistory();
    setDraftConflict(false);
    setHasUnsavedChanges(true);
    // Re-stamp the draft against the CURRENT base hash so "Restore anyway"
    // doesn't re-surface the same conflict on the next reload.
    if (typeof window !== "undefined") { try { window.localStorage.setItem(draftKey, JSON.stringify({ meta: JSON.parse(draftJson), baseHash: serverBaseHashRef.current })); } catch {} }
    const emitted = JSON.stringify(restored);
    rememberEmitted(emitted);
    stateRef.current.onChange?.(emitted);
  }, [syncHistory, draftKey, rememberEmitted]);

  const discardDraft = useCallback(() => {
    if (typeof window !== "undefined") { try { window.localStorage.removeItem(draftKey); } catch {} }
    conflictDraftRef.current = null;
    setDraftConflict(false);
  }, [draftKey]);

  // Once, on mount: decide what to do with any persisted draft.
  useEffect(() => {
    if (draftHandledRef.current) return;
    draftHandledRef.current = true;
    const draft = readDraft();
    if (!draft) return;
    const base = fixMeta(metaComponents || []);
    
    if (isEqual(pruneDocStructure(draft.meta), pruneDocStructure(base))) {
      discardDraft();
      return;
    }
    // Server base changed since the draft was saved -> the draft is stale. Don't
    // silently apply it over newer content; tell the client so the user decides.
    if (draft.baseHash !== serverBaseHashRef.current) {
      conflictDraftRef.current = draft.meta;
      setDraftConflict(true);
      return;
    }
    applyDraft(draft.meta);
  }, [applyDraft, discardDraft]);

  // Re-sync to the server meta only when the prop actually changes AFTER mount
  // (reload / navigation), never on the initial mount — that would race the
  // draft-restore effect above and clobber the restored draft.
  const initialMetaSyncRef = useRef(true);
  useEffect(() => {
    if (initialMetaSyncRef.current) { initialMetaSyncRef.current = false; return; }
    if (commitTimerRef.current !== null) return;
    // Detect a real server-content change by hashing the RAW prop against the
    // recorded base hash. The old check (isEqual of the fixMeta'd local tree
    // vs the raw prop) was almost always unequal, so any parent re-render
    // with a fresh prop reference clobbered local edits and history.
    const nextHash = hashStr(JSON.stringify(metaComponents || []));
    if (nextHash !== serverBaseHashRef.current) {
      // Echo of our own edit coming back through the form -> not a server
      // change: keep local state, history and the draft untouched.
      if (emittedHashesRef.current.has(nextHash)) return;
      const next = fixMeta(metaComponents || []);
      storeRef.current.populate(next);
      const baseJson = JSON.stringify(storeRef.current.reconcileTree(next));
      serverBaseHashRef.current = nextHash;
      historyRef.current = { stack: [baseJson], index: 0 };
      setLocalMetaComponents(next);
      syncHistory();
      setHasUnsavedChanges(false);
      emittedHashesRef.current.clear();
      // Re-evaluate any stored draft against the NEW server content: one that
      // matches is a leftover from a completed save -> delete it; one that
      // differs is kept and surfaced as a conflict the user can restore.
      const draft = readDraft();
      if (draft && !isEqual(pruneDocStructure(draft.meta), pruneDocStructure(next))) {
        conflictDraftRef.current = draft.meta;
        setDraftConflict(true);
      } else {
        if (draft && typeof window !== "undefined") { try { window.localStorage.removeItem(draftKey); } catch {} }
        setDraftConflict(false);
      }
    }
  }, [metaComponents, draftKey]);

  useEffect(() => {
    return () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    };
  }, []);

  const findElement = useCallback((field, value, els) => {
    const list = els ?? stateRef.current.localMetaComponents;
    if (!value || value == "null" || value.length == 0 || !list) return null;

    for (let i = 0; i < list.length; i++) {
      if ((field == "node" && getNodeKey(list[i]) == value) || (field != "node" && list[i]?.data?.[field] == value)) {
        return list[i];
      } else if (Array.isArray(list[i]?.elements)) {
        const found = findElement(field, value, list[i].elements || []);
        if (found) return found;
      }
    }

    return null;
  }, []);

  const [updatingElement, setUpdatingElement] = useState(() =>
    findElement("node", updatingElementName)
  );

  useEffect(() => {
    const found = findElement("node", updatingElementName, localMetaComponents);

    setUpdatingElement(prev => {
      if (prev && found && getNodeKey(prev) === getNodeKey(found)) return prev;
      if (!found) return null;

      const nodeKey = getNodeKey(found);
      const liveData = storeRef.current.get(nodeKey) || found.data;
      return liveData === found.data ? found : { ...found, node: nodeKey, data: liveData };
    });
  }, [updatingElementName, localMetaComponents, findElement]);

  const scheduleCommit = useCallback(() => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      const reconciled = storeRef.current.reconcileTree(stateRef.current.localMetaComponents);
      const json = JSON.stringify(reconciled);

      const h = historyRef.current;
      if (h.stack[h.index] !== json) {
        h.stack = h.stack.slice(0, h.index + 1);
        h.stack.push(json);
        if (h.stack.length > 100) h.stack.shift();
        h.index = h.stack.length - 1;
        syncHistory();
      }
      const dirty = json !== h.stack[0];
      if (typeof window !== "undefined") {
        try {
          // A no-op commit must not leave a draft behind: stale drafts are
          // what resurfaced as phantom conflict/unsaved banners on reload.
          if (dirty) window.localStorage.setItem(draftKey, JSON.stringify({ meta: reconciled, baseHash: serverBaseHashRef.current }));
          else window.localStorage.removeItem(draftKey);
        } catch {}
      }
      setHasUnsavedChanges(dirty);
      rememberEmitted(json);
      stateRef.current.onChange?.(json);
    }, 300);
  }, [syncHistory, draftKey, rememberEmitted]);

  // External content loaded INTO the design as a user edit (history entry,
  // unsaved badge, draft, echo-filtered onChange) — never as a server reset,
  // which would drop the undo history and could raise a false draft conflict.
  //   Emitter.emit("designer:load", { field: "doc_structure", elements, mode: "replace" | "append" })
  // Used by the Print Format Builder's "Load entity".
  useEffect(() => {
    const onLoad = ({ field, elements, mode = "replace" } = {}) => {
      if (!field || field !== data?.name) return;
      const incoming = fixMeta(Array.isArray(elements) ? elements : []);
      const next = mode === "append"
        ? [...(stateRef.current.localMetaComponents || []), ...incoming]
        : incoming;
      storeRef.current.populate(next);
      setLocalMetaComponents(next);
      scheduleCommit();
    };
    Emitter.on("designer:load", onLoad);
    return () => Emitter.off("designer:load", onLoad);
  }, [data?.name, scheduleCommit]);

  const applyHistory = useCallback((json) => {
    if (commitTimerRef.current) { clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
    const state = JSON.parse(json);
    storeRef.current.populate(state);
    setLocalMetaComponents(state);
    const dirty = json !== historyRef.current.stack[0];
    if (typeof window !== "undefined") {
      try {
        if (dirty) window.localStorage.setItem(draftKey, JSON.stringify({ meta: state, baseHash: serverBaseHashRef.current }));
        else window.localStorage.removeItem(draftKey); // undone back to base -> nothing to restore
      } catch {}
    }
    setHasUnsavedChanges(dirty);
    rememberEmitted(json);
    stateRef.current.onChange?.(json);

    const selKey = stateRef.current.updatingElementName;
    if (selKey && selKey !== "null") {
      const found = findElement("node", selKey, state);
      if (found) {
        const nodeKey = getNodeKey(found);
        const liveData = storeRef.current.get(nodeKey) || found.data;
        setUpdatingElement({ ...found, node: nodeKey, data: liveData, __version__: Date.now() });
      } else {
        setUpdatingElement(null);
      }
    }
  }, [findElement, draftKey, rememberEmitted]);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    h.index -= 1;
    applyHistory(h.stack[h.index]);
    syncHistory();
  }, [applyHistory, syncHistory]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    applyHistory(h.stack[h.index]);
    syncHistory();
  }, [applyHistory, syncHistory]);

  // `asBase`: structural normalization a component applies on its own when it
  // mounts (e.g. Row adding the columns its layout requires). It is NOT a user
  // edit: it is folded into the history base (stack[0]) without a draft, the
  // "Unsaved changes" badge or onChange. Otherwise every load of a document
  // that needs normalizing writes a draft that differs from the server, which
  // resurfaces as a permanent "Unsaved changes" (or a conflict) on reload.
  // Only honored while the user hasn't edited yet; afterwards it's a normal edit.
  const setMeta = useCallback((meta, { asBase = false } = {}) => {
    let parsed;
    if (Array.isArray(meta)) {
      parsed = meta;
    } else if (loopar.utils.isJSON(meta)) {
      parsed = JSON.parse(meta);
    } else {
      console.error(["Invalid meta payload", meta]);
      loopar.throw("Invalid meta payload");
      return;
    }

    const fixed = fixMeta(parsed);

    storeRef.current.populate(fixed);
    setLocalMetaComponents(fixed);

    const h = historyRef.current;
    if (asBase && h.index === 0 && commitTimerRef.current === null) {
      h.stack = [JSON.stringify(storeRef.current.reconcileTree(fixed))];
      syncHistory();
      return;
    }

    scheduleCommit();
  }, [scheduleCommit, syncHistory]);

  const updateElements = useCallback((target, elements, current = null, options = {}) => {
    const currentElements = storeRef.current.reconcileTree(stateRef.current.localMetaComponents);
    const selfKeyNow = stateRef.current.selfKey;
    const targetKey = getNodeKey(target);
    const currentKey = current ? getNodeKey(current) : null;
    const lastParentKey = current ? current.parentKey : null;

    const setElementsInTarget = (structure) => {
      return structure.map((el) => {
        el.elements = getNodeKey(el) === targetKey ? elements
          : setElementsInTarget(el.elements || []);
        return el;
      });
    };

    let newElements = targetKey === selfKeyNow ? elements
      : setElementsInTarget(currentElements, selfKeyNow);

    const deleteCurrentOnLastParent = (structure, parent) => {
      if (lastParentKey === parent) {
        return structure.filter(e => getNodeKey(e) !== currentKey);
      }

      return structure.map(el => {
        el.elements = deleteCurrentOnLastParent(el.elements || [], getNodeKey(el));
        return el;
      });
    };

    if (current && lastParentKey !== targetKey) {
      newElements = deleteCurrentOnLastParent(newElements, selfKeyNow);
    }

    setMeta(JSON.stringify(newElements), options);
  }, [setMeta]);

  const updateElement = useCallback((node, data, merge = true, fromEditor = false) => {
    const { localMetaComponents: current, updatingElementName: editingName } = stateRef.current;
    const store = storeRef.current;

    if (data.name) {
      const reconciled = store.reconcileTree(current);
      const exist = findElement("name", data.name, reconciled);

      if (exist && getNodeKey(exist) !== node) {
        console.error(["Duplicate field", getNodeKey(exist), node, data.name]);
        return loopar.throw(
          "Duplicate field",
          `The field with the name: ${data.name} already exists, your current field will keep the name: ${data.name} please check your fields and try again.`,
          false
        );
      }
    }

    if (fromEditor) {
      store.update(node, data, merge);
      scheduleCommit();
      return;
    }

    const reconciled = store.reconcileTree(current);
    setMeta(JSON.stringify(updateE(reconciled, data, node, merge)));

    if ( node === editingName) {
      setUpdatingElement(prev => prev ? {
        ...prev,
        data: merge ? {...prev.data, ...data} : {...data},
        __version__: (prev.__version__ || 0) + 1
      } : prev);
    }
  }, [findElement, setMeta, scheduleCommit]);

  // Current structure for the AI prompt ("edit current design" mode)
  const getCurrentDesign = useCallback(() => {
    return storeRef.current.reconcileTree(stateRef.current.localMetaComponents);
  }, []);

  const deleteElement = useCallback((element) => {
    const removeElement = (elements) => {
      return elements.filter((el) => {
        if (getNodeKey(el) === element) return false;
        if (el.elements) el.elements = removeElement(el.elements);
        return true;
      });
    };

    const reconciled = storeRef.current.reconcileTree(stateRef.current.localMetaComponents);
    setMeta(JSON.stringify(removeElement(reconciled)));
  }, [setMeta]);

  const handleSetMode = useCallback((newMode) => {
    stateRef.current.setDesignerModeType(newMode);
    stateRef.current.handleSetSidebarOpen(true);
  }, []);

  const handleChangeMode = useCallback((opt = null) => {
    const { designerModeType: modeNow, sidebarOpen: openNow } = stateRef.current;
    const newMode = opt !== null ? opt : (
      ["preview", "editor"].includes(modeNow) ? (!openNow ? "preview" : "designer") : "preview"
    );

    handleSetMode(newMode);
  }, [handleSetMode]);

  const handleEditElement = useCallback((element) => {
    stateRef.current.setUpdatingElementName(element);
    handleChangeMode(element ? "editor" : "designer");
  }, [handleChangeMode]);

  const handleDeleteElement = useCallback((element) => {
    loopar.confirm("Are you sure you want to delete this element?", () => {
      deleteElement(element);
    });
  }, [deleteElement]);

  useEffect(() => {
    const onKey = (e) => {
      if (stateRef.current.designerModeType === "preview") return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }

      const selKey = stateRef.current.updatingElementName;
      if (!selKey || selKey === "null") return;

      if (e.key === "Escape") {
        handleEditElement(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleDeleteElement(selKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleEditElement, handleDeleteElement, undo, redo]);

  useEffect(() => {
    if (designerMode) return;

    if (!updatingElementName || updatingElementName == "null") {
      handleSetMode("designer");
    } else if (!findElement("node", updatingElementName)) {
      setUpdatingElementName(null);
    }
  }, []);

  const handleSetMeta = useCallback((e) => {
    e.preventDefault();

    !designerMode && loopar.prompt({
      title: "META",
      label: "JSON META object",
      placeholder: "Enter a valid JSON META object",
      ok: setMeta,
      size: "lg",
      validate: (meta) => {
        !loopar.utils.isJSON(meta) && loopar.throw("Invalid JSON object");
        return true;
      }
    });
  }, [designerMode, setMeta]);

  const isDesigner = typeof designerMode != "undefined" ? !designerMode : true;

  const designerRef = useMemo(
    () => ({ updateElements, updateElement }),
    [updateElements, updateElement]
  );

  const designing = designerModeType === "designer" || designerModeType === "editor";

  const contextValue = useMemo(() => ({
    designerMode: isDesigner,
    designerModeType,
    designerRef,
    updateElements,
    updatingElement,
    updateElement,
    designing,
    handleEditElement,
    handleDeleteElement,
    activeId,
    handleChangeMode,
    handleSetMode,
    updatingFromEditor,
    dragEnabled,
    setDragEnable,
    undo,
    redo,
    canUndo,
    canRedo,
  }), [
    isDesigner,
    designerModeType,
    designerRef,
    updateElements,
    updatingElement,
    updateElement,
    designing,
    undo,
    redo,
    canUndo,
    canRedo,
    handleEditElement,
    handleDeleteElement,
    activeId,
    handleChangeMode,
    handleSetMode,
    updatingFromEditor,
    dragEnabled,
  ]);

  return (
    <ElementStoreContext.Provider value={storeRef.current}>
    <DesignerContext.Provider value={contextValue}>
      <BaseFormContext.Provider value={{}}>
        <div className="">
            <Prompt
              defaultPrompt={currentPrompt}
              open={sendingPrompt}
              onClose={() => setSendingPrompt(false)}
              onComplete={setMeta}
              getCurrentDesign={getCurrentDesign}
            />
          <div className="flex w-full flex-row justify-between pt-2 px-2 pb-0">
            <div>
              <h2 className="text-3xl">{data.label}</h2>
              {draftConflict ? (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-destructive">
                  <span>A local draft from an earlier version was found (the server content has changed).</span>
                  <button type="button" className="underline" onClick={() => applyDraft(conflictDraftRef.current)}>Restore anyway</button>
                  <button type="button" className="underline" onClick={discardDraft}>Discard</button>
                </div>
              ) : hasUnsavedChanges ? (
                <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-600">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  <span>Unsaved changes</span>
                </div>
              ) : null}
            </div>
            <div className="space-x-1">
              <Button variant="secondary" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
                <Undo2/>
              </Button>
              <Button variant="secondary" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
                <Redo2/>
              </Button>
              {/* <Button
                className={dragEnabled ? 'bg-red-500' : 'bg-secondary'}
                onClick={() => {
                  setDragEnable && setDragEnable(!dragEnabled);
                }}
              >
                <HandGrab/>
              </Button> */}
              <Button
                variant="secondary"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  !designerMode && handleChangeMode();
                }}
              >
                <DesignerButton/>
              </Button>
              <Button variant="secondary" onClick={handleSetMeta}>
                <BracesIcon className="mr-2" />
                META
              </Button>
              <Button
                variant="secondary"
                onClick={() => setSendingPrompt(true)}
              >
                <SparkleIcon className="mr-2" />
                Design AI
              </Button>
            </div>
          </div>
          <Tabs
            data={{ name: selfKey}}
            key={selfKey}
            asChild={true}
            canCustomize={false}
          >
            <Tab
              label={<div className="flex"><BrushIcon className="h-6 w-6 pr-2" /> Designer</div>}
              name={`${selfKey}-designer_tab`}
              key={`${selfKey}-designer_tab`}
            >
              <div
                className={cn("rounded border shadow-sm w-full", designerModeType === "preview" ? "p-3" : "")}
              >
                <DragAndDropProvider
                  metaComponents={localMetaComponents}
                  data={data}
                  node={selfKey}
                  onDrop={setMeta}
                >
                  {sidebarOpen && <Sidebar/>}
                </DragAndDropProvider>
              </div>
            </Tab>
            <Tab
              label={<div className="flex"><BracesIcon className="h-6 w-6 pr-2" /> META</div>}
              name={`${selfKey}-meta_tab`}
              key={`${selfKey}-meta_tab`}
            >
              <div className="max-h-[720px] overflow-x-auto">
                <div
                  className="contents w-full prose dark:prose-invert"
                >
                  <MarkdownPreview source={`\`\`\`jsx\n${JSON.stringify(metaComponents, null, 2)}\n\`\`\``} />
                </div>
              </div>
            </Tab>
            <Tab
              label={<div className="flex"><BrushCleaning className="h-6 w-6 pr-2" /> Clean</div>}
              name={`${selfKey}-clean_tab`}
              key={`${selfKey}-clean_tab`}
            >
              <div className="max-h-[720px] overflow-x-auto">
                <div
                  className="contents w-full prose dark:prose-invert"
                >
                  {!!name &&
                    <OrphanColumnsManager
                      document={name}
                    />
                  }
                </div>
              </div>
            </Tab>
          </Tabs>
        </div>
      </BaseFormContext.Provider>
    </DesignerContext.Provider>
    </ElementStoreContext.Provider>
  )
}

export const Designer = (props) => {
  const {designerMode} = useDesigner();
  if (!designerMode) {
    return <BaseDesigner {...props} />
  }

  const {data} = props;
  
  return (
    <div className="">
      <div className="flex w-full flex-row justify-between pt-2 px-2 pb-0">
        <div>
          <h2 className="text-3xl">{data.label}</h2>
        </div>
        <div className="space-x-1 pointer-events-none">
          <Button variant="secondary">
            <BrushIcon className="mr-2" />
            Design
          </Button>
          <Button variant="secondary">
            <BracesIcon className="mr-2" />
            META
          </Button>
          <Button
            variant="secondary"
          >
            <SparkleIcon className="mr-2" />
            Design AI
          </Button>
        </div>
      </div>
      <div className="w-full p-2">
        <div className="flex items-center bg-slate-700/50 justify-center h-[60px]">
          <h1 className="text-center text-2xl font-bold">Design area</h1>
        </div>
      </div>
    </div>
  )
}