import loopar from "loopar";
import { BrushIcon, BracesIcon, EyeIcon, SparkleIcon, HandGrab, BrushCleaning, Undo2, Redo2, LanguagesIcon } from "lucide-react";
import { TranslationsTab, useHasTranslations } from "./translations-tab";
import { BaseFormContext } from "@form-context";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { DesignerContext, useDesigner } from "@context/designer-context";
import MetaComponent from "@meta-component";
import { PreviewModal, guardInteractions } from "./preview-frame";
import { Maximize2 } from "lucide-react";
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
import {elementsNames, documentContextName} from "@global/element-definition";
import {OrphanColumnsManager} from "./src/OrphanColumnsManager.jsx"
import { ElementStore, ElementStoreContext } from "./element-store.js";
import { getNodeKey, pruneDocStructure } from "@global/prune-doc-structure";
import Emitter from "@services/emitter/emitter";
import { __ } from "@global/i18n";

const updateE = (structure, data, node, merge) => {
  return structure.map((el) => {
    if (!el.data) return el;

    const newEl = {...el, data: {...el.data}};

    if (!elementsNames.includes(newEl.element)) {
      newEl.data.tag = newEl.element;
      newEl.element = "div";
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

// Preview renders the canvas with the same designer context the public site
// sees (no designer mode), so no wrappers, drop zones or design-only spacing
// are mounted: what you see is what gets published.
const PREVIEW_CONTEXT = { designerMode: false, designing: false, designerModeType: "preview", previewing: true };

// Web pages bring their own spacing (sections). Everything else is rendered
// by a host container in the desk or auth shell; the preview mirrors it:
// desk content padding + the host's stacking (auth forms: gap-4, desk forms:
// space-y-3, desk pages: the app gap, 1rem by default).
const PREVIEW_HOST = {
  form: "px-4 pt-2 pb-4 flex flex-col gap-4",
  desk: "px-4 pt-2 pb-4 flex flex-col gap-4",
  print: "px-4 pt-2 pb-4",
};
const PREVIEW_HOST_BY_TYPE = {
  Entity: "px-4 pt-2 pb-4 flex flex-col gap-3",
};
const previewHostClass = (documentType) =>
  PREVIEW_HOST_BY_TYPE[documentType] || PREVIEW_HOST[documentContextName(documentType)];

const hashStr = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
};

const DesignerButton = () => {
  const { designerMode, previewInline } = useDesigner();
  const { sidebarOpen, name } = useDocument();

  if (!designerMode || previewInline) {
    return <><BrushIcon className="mr-2" /> {__("Design")}</>
  }

  // Designing with the side panel closed: the button reopens the panel.
  if (!sidebarOpen) {
    return <><BrushIcon className="mr-2" /> {__("Design")}</>
  }

  return <><EyeIcon className="mr-2" /> {__("Preview")}</>
}

export const BaseDesigner = (props) => {
  const {data, node, metaComponents} = props;
  const [activeId] = useState(null);
  const {designerMode} = useDesigner();
  const {name, entity, sidebarOpen, handleSetSidebarOpen} = useDocument();
  // The layout's translations live in the document's `translations` field.
  const hasTranslations = useHasTranslations();
  const [dragEnabled, setDragEnable] = useState(true);

  const [updatingElementName, setUpdatingElementName] = usePersist(name + "updatingElementName");
  // Side panel view: "elements" (palette) | "navigator" | "properties".
  // null = follow the mode (editor → properties, otherwise the palette).
  const [sidebarView, setSidebarView] = useState(null);
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

  // The form-level "discard unsaved changes" (use-form-draft) covers this
  // designer too: drop our draft and go back to the server base. The form has
  // already reset the field, so no onChange here; the resulting prop update
  // hashes to the base and is ignored by the re-sync effect below.
  useEffect(() => {
    const onDiscard = (evt = {}) => {
      if (evt.entity !== entity || (evt.name || "__new__") !== (name || "__new__")) return;
      if (commitTimerRef.current) { clearTimeout(commitTimerRef.current); commitTimerRef.current = null; }
      discardDraft();
      const baseJson = historyRef.current.stack[0];
      const base = JSON.parse(baseJson);
      storeRef.current.populate(base);
      historyRef.current = { stack: [baseJson], index: 0 };
      emittedHashesRef.current.clear();
      setLocalMetaComponents(base);
      setHasUnsavedChanges(false);
      syncHistory();
    };
    Emitter.on("form-draft:discard", onDiscard);
    return () => Emitter.off("form-draft:discard", onDiscard);
  }, [entity, name, discardDraft, syncHistory]);

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

  // Switching between design and preview remounts the whole canvas (wrappers
  // in, wrappers out), so the page height changes and a raw scroll offset
  // lands somewhere else. Instead, anchor on the element under the reading
  // line and bring that same element back to the same screen position.
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const scrollAnchorRef = useRef(null);
  // Preview, two levels:
  // - inline: rendered in the canvas itself, same container, width and
  //   breakpoints as the designer (coherent by construction);
  // - full screen (previewOpen): its own frame/viewport over everything, with
  //   device widths — the real render.
  const [previewInline, setPreviewInline] = useState(false);
  // Design ⇄ inline preview swaps the whole canvas tree (and may load element
  // modules). As a transition, the current view stays on screen until the new
  // one is ready, instead of flashing Suspense fallbacks / half-built layouts.
  const [switchingPreview, startPreviewTransition] = useTransition();
  const [previewOpen, setPreviewOpen] = useState(false);
  const inlinePreviewRef = useRef(null);
  stateRef.current.previewOpen = previewOpen;
  stateRef.current.previewInline = previewInline;

  // Preview renders inside an iframe: its document is where nodes live then.
  const frameDoc = () => {
    const frame = frameRef.current;
    return frame?.isConnected ? frame.contentDocument : null;
  };

  // Viewport-relative top of a node, in host coordinates (frame nodes are
  // offset by the frame's own position).
  const topOf = (el) => {
    const top = el.getBoundingClientRect().top;
    return el.ownerDocument === document ? top : top + frameRef.current.getBoundingClientRect().top;
  };


  const nodeKeys = () => {
    const keys = new Set();
    const walk = (elements) => (elements || []).forEach(el => {
      if (!el?.data) return;
      keys.add(getNodeKey(el));
      walk(el.elements);
    });
    walk(stateRef.current.localMetaComponents);
    return keys;
  };

  // Design wrappers carry data-node-key; the published render exposes the key
  // as `node` (containers) or `id` (leaves).
  const keyOf = (el) => el.getAttribute?.("data-node-key") || el.getAttribute?.("node") || el.id || null;

  // `inFrame`: look only in the preview frame (true) or only in the design
  // canvas (false) — while the frame loads, the canvas underneath still has
  // the same keys and must not be scrolled instead.
  const findByKey = (key, inFrame) => {
    const root = inFrame ? frameDoc()?.getElementById("lp-preview-root") : canvasRef.current;
    if (!root || !key) return null;
    const k = CSS.escape(key);
    return root.querySelector(`[data-node-key="${k}"]`) || root.querySelector(`[node="${k}"]`) || root.querySelector(`#${k}`);
  };

  // Element under the reading line (a third down the visible area) of the
  // preview frame when it is open, of the design canvas otherwise.
  const captureScrollAnchor = () => {
    if (typeof window === "undefined") return null;
    const keys = nodeKeys();
    const frame = frameRef.current;
    let el, stop;

    if (frame?.isConnected) {
      const fr = frame.getBoundingClientRect();
      const doc = frameDoc();
      el = doc?.elementFromPoint(fr.width / 2, fr.height * 0.35) || null;
      stop = doc?.body;
    } else {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      // The side panel is fixed over the right edge; probe the visible canvas.
      const right = Math.min(rect.right, stateRef.current.sidebarOpen ? window.innerWidth - 300 : window.innerWidth);
      const x = Math.max(rect.left + 8, (rect.left + right) / 2);
      const y = Math.min(Math.max(window.innerHeight * 0.35, rect.top + 8), rect.bottom - 8);
      if (y <= rect.top) return null;
      el = document.elementFromPoint(x, y);
      stop = canvas;
    }

    while (el && el !== stop) {
      const key = keyOf(el);
      if (key && keys.has(key)) return { key, offset: topOf(el) };
      el = el.parentElement;
    }
    return null;
  };

  const openPreview = useCallback(() => {
    const anchor = captureScrollAnchor();
    scrollAnchorRef.current = anchor && { ...anchor, inFrame: true };
    setPreviewOpen(true);
  }, []);

  const setInline = useCallback((on) => {
    if (stateRef.current.previewInline === on) return;
    const anchor = captureScrollAnchor();
    scrollAnchorRef.current = anchor && { ...anchor, inFrame: false };
    startPreviewTransition(() => setPreviewInline(on));
  }, []);

  const closePreview = useCallback(() => {
    if (!stateRef.current.previewOpen) return;
    const anchor = captureScrollAnchor();
    scrollAnchorRef.current = anchor && { ...anchor, inFrame: false };
    setPreviewOpen(false);
  }, []);

  useEffect(() => {
    const anchor = scrollAnchorRef.current;
    scrollAnchorRef.current = null;
    if (!anchor) return;

    // Modules and wrappers mount over a few frames: keep correcting until the
    // anchor holds still, and give up as soon as the user scrolls.
    let cancelled = false, frames = 0, stable = 0;
    const cancel = () => { cancelled = true; };
    const events = ["wheel", "touchmove", "keydown", "pointerdown"];
    const targets = [window];
    const listen = (w) => {
      if (!w || targets.includes(w)) return;
      targets.push(w);
      events.forEach(ev => w.addEventListener(ev, cancel, { passive: true }));
    };
    events.forEach(ev => window.addEventListener(ev, cancel, { passive: true }));

    const tick = () => {
      if (cancelled) return;
      frames++;
      const el = findByKey(anchor.key, anchor.inFrame);
      if (el) {
        // Opening restores inside the frame; closing restores the designer.
        const inFrame = el.ownerDocument !== document;
        inFrame && listen(el.ownerDocument.defaultView);
        const delta = topOf(el) - anchor.offset;
        if (Math.abs(delta) > 1) {
          (inFrame ? el.ownerDocument.defaultView : window).scrollBy(0, delta);
          stable = 0;
        } else {
          stable++;
        }
      }
      // setTimeout, not rAF: animation frames pause in background tabs.
      if (stable < 6 && frames < 240) timer = setTimeout(tick, 16);
      else cleanup();
    };
    const cleanup = () => targets.forEach(w => events.forEach(ev => w.removeEventListener(ev, cancel)));

    let timer = setTimeout(tick, 16);
    return () => { cancel(); clearTimeout(timer); cleanup(); };
  }, [previewOpen, previewInline]);

  // Inline preview: same link/action guard the full-screen frame uses.
  useEffect(() => {
    if (!previewInline) return;
    return guardInteractions(inlinePreviewRef.current);
  }, [previewInline]);

  // "preview" used to be a designer mode; a persisted one resumes as design.
  useEffect(() => {
    designerModeType === "preview" && setDesignerModeType("designer");
  }, [designerModeType]);

  // "preview" = inline preview; design modes leave it and open the panel.
  const handleSetMode = useCallback((newMode) => {
    if (newMode === "preview") return setInline(true);
    setInline(false);
    stateRef.current.setDesignerModeType(newMode);
    stateRef.current.handleSetSidebarOpen(true);
  }, [setInline]);

  // Toolbar toggle: full screen → back to inline; inline → design; a closed
  // side panel is reopened; otherwise design → inline preview.
  const handleChangeMode = useCallback((opt = null) => {
    if (opt !== null) return handleSetMode(opt);
    if (stateRef.current.previewOpen) return closePreview();
    if (stateRef.current.previewInline) return setInline(false);
    if (!stateRef.current.sidebarOpen) return stateRef.current.handleSetSidebarOpen(true);
    setInline(true);
  }, [handleSetMode, setInline, closePreview]);

  // Ancestor chain (root → element) of a node, for the selection breadcrumb.
  const getElementPath = useCallback((key) => {
    const walk = (elements, trail) => {
      for (const el of elements || []) {
        if (!el?.data) continue;
        const k = getNodeKey(el);
        const next = [...trail, { key: k, element: el.element }];
        if (k === key) return next;
        const found = walk(el.elements, next);
        if (found) return found;
      }
      return null;
    };
    return walk(stateRef.current.localMetaComponents, []) || [];
  }, []);

  const handleEditElement = useCallback((element) => {
    stateRef.current.setUpdatingElementName(element);
    setSidebarView(v => element ? "properties" : (v === "properties" ? null : v));
    handleChangeMode(element ? "editor" : "designer");
  }, [handleChangeMode]);

  // Selects without switching the side panel view (used by the navigator).
  const selectElement = useCallback((element) => {
    stateRef.current.setUpdatingElementName(element);
    handleChangeMode(element ? "editor" : "designer");
  }, [handleChangeMode]);

  // Moves a node next to (before/after) or into (inside, appended) another one.
  // Same path as any structural edit: setMeta → commit → undo history.
  const moveElement = useCallback((key, targetKey, position) => {
    if (!key || !targetKey || key === targetKey) return;

    const tree = storeRef.current.reconcileTree(stateRef.current.localMetaComponents);
    let moved = null;

    const remove = (elements) => (elements || []).reduce((acc, el) => {
      if (el?.data && getNodeKey(el) === key) {
        moved = el;
        return acc;
      }
      acc.push(el?.elements ? { ...el, elements: remove(el.elements) } : el);
      return acc;
    }, []);

    const place = (elements) => {
      const i = elements.findIndex(el => el?.data && getNodeKey(el) === targetKey);
      if (i >= 0) {
        const copy = [...elements];
        if (position === "inside") {
          copy[i] = { ...copy[i], elements: [...(copy[i].elements || []), moved] };
        } else {
          copy.splice(position === "after" ? i + 1 : i, 0, moved);
        }
        return [copy, true];
      }

      let done = false;
      const out = elements.map(el => {
        if (done || !el?.elements) return el;
        const [children, ok] = place(el.elements);
        if (!ok) return el;
        done = true;
        return { ...el, elements: children };
      });
      return [out, done];
    };

    const without = remove(tree);
    if (!moved) return;
    const [next, ok] = place(without);
    if (!ok) return;

    setMeta(JSON.stringify(next));
  }, [setMeta]);

  const handleDeleteElement = useCallback((element) => {
    loopar.confirm("Are you sure you want to delete this element?", () => {
      deleteElement(element);
    });
  }, [deleteElement]);

  useEffect(() => {
    const onKey = (e) => {
      if (stateRef.current.previewOpen || stateRef.current.previewInline) return;
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
    getElementPath,
    selectElement,
    moveElement,
    metaTree: localMetaComponents,
    sidebarView,
    setSidebarView,
    previewInline,
    openPreview,
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
    selectElement,
    moveElement,
    localMetaComponents,
    sidebarView,
    previewInline,
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
                  <span>{__("A local draft from an earlier version was found (the server content has changed).")}</span>
                  <button type="button" className="underline" onClick={() => applyDraft(conflictDraftRef.current)}>{__("Restore anyway")}</button>
                  <button type="button" className="underline" onClick={discardDraft}>{__("Discard")}</button>
                </div>
              ) : hasUnsavedChanges ? (
                <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-600">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  <span>{__("Unsaved changes")}</span>
                </div>
              ) : null}
            </div>
            <div className="space-x-1">
              <Button variant="secondary" title={__("Undo (Ctrl+Z)")} disabled={!canUndo} onClick={undo}>
                <Undo2/>
              </Button>
              <Button variant="secondary" title={__("Redo (Ctrl+Shift+Z)")} disabled={!canRedo} onClick={redo}>
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
                {__("META")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setSendingPrompt(true)}
              >
                <SparkleIcon className="mr-2" />
                {__("Design AI")}
              </Button>
            </div>
          </div>
          <Tabs
            data={{ name: selfKey}}
            key={selfKey}
            asChild={true}
            canCustomize={false}
          >
            {[
            <Tab
              label={<div className="flex"><BrushIcon className="h-6 w-6 pr-2" /> {__("Designer")}</div>}
              name={`${selfKey}-designer_tab`}
              key={`${selfKey}-designer_tab`}
            >
              <div
                ref={canvasRef}
                aria-busy={switchingPreview || undefined}
                className={cn("rounded border shadow-sm w-full transition-opacity duration-150", switchingPreview && "opacity-60 pointer-events-none")}
              >
                {previewInline ? (
                  <>
                    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                      <EyeIcon className="h-3.5 w-3.5"/>
                      <span className="font-medium text-foreground">{__("Preview")}</span>
                      <span className="hidden sm:inline">{__("Links and actions are disabled")}</span>
                      <button
                        type="button"
                        className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted hover:text-foreground"
                        title={__("Full screen preview with device widths")}
                        onClick={openPreview}
                      >
                        <Maximize2 className="h-3.5 w-3.5"/>
                        {__("Full screen")}
                      </button>
                    </div>
                    <div ref={inlinePreviewRef}>
                      <DesignerContext.Provider value={PREVIEW_CONTEXT}>
                        <div className={previewHostClass(entity)}>
                          <MetaComponent elements={localMetaComponents} parentKey={selfKey} />
                        </div>
                      </DesignerContext.Provider>
                    </div>
                    {sidebarOpen && <Sidebar/>}
                  </>
                ) : (
                  <DragAndDropProvider
                    metaComponents={localMetaComponents}
                    data={data}
                    node={selfKey}
                    onDrop={setMeta}
                  >
                    {sidebarOpen && <Sidebar/>}
                  </DragAndDropProvider>
                )}
              </div>
              <PreviewModal
                open={previewOpen}
                title={name || data.label}
                onClose={closePreview}
                frameRef={frameRef}
              >
                <DesignerContext.Provider value={PREVIEW_CONTEXT}>
                  <div className={previewHostClass(entity)}>
                    <MetaComponent elements={localMetaComponents} parentKey={selfKey} />
                  </div>
                </DesignerContext.Provider>
              </PreviewModal>
            </Tab>,
            <Tab
              label={<div className="flex"><BracesIcon className="h-6 w-6 pr-2" /> {__("META")}</div>}
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
            </Tab>,
            <Tab
              label={<div className="flex"><BrushCleaning className="h-6 w-6 pr-2" /> {__("Clean")}</div>}
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
              ,
              hasTranslations && (
                <Tab
                  label={<div className="flex"><LanguagesIcon className="h-6 w-6 pr-2" /> {__("Translations")}</div>}
                  name={`${selfKey}-translations_tab`}
                  key={`${selfKey}-translations_tab`}
                >
                  <TranslationsTab metaComponents={localMetaComponents} />
                </Tab>
              ),
            ].filter(Boolean)}
          </Tabs>
        </div>
      </BaseFormContext.Provider>
    </DesignerContext.Provider>
    </ElementStoreContext.Provider>
  )
}

export const Designer = (props) => {
  const {designerMode, previewing} = useDesigner();
  // In the preview a nested designer field (e.g. the Entity form's structure)
  // shows its placeholder: a live designer there would mount its own side
  // panel inside the preview frame.
  if (!designerMode && !previewing) {
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
            {__("Design")}
          </Button>
          <Button variant="secondary">
            <BracesIcon className="mr-2" />
            {__("META")}
          </Button>
          <Button
            variant="secondary"
          >
            <SparkleIcon className="mr-2" />
            {__("Design AI")}
          </Button>
        </div>
      </div>
      <div className="w-full p-2">
        <div className="flex items-center bg-slate-700/50 justify-center h-[60px]">
          <h1 className="text-center text-2xl font-bold">{__("Design area")}</h1>
        </div>
      </div>
    </div>
  )
}