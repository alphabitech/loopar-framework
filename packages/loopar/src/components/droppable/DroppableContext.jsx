import {createContext, useContext, useCallback, useMemo, useRef} from "react";
import { useDragAndDrop } from "./DragAndDropContext";
import { elementsDict } from "@global/element-definition";

export const DroppableContext = createContext({});

export const useDroppable = () => useContext(DroppableContext);

export const DroppableContextProvider = ({data, node, children, ...props }) => {
  const __REFS__ = useRef({}).current;
  const { 
    dropZone, setDropZone, 
    currentDragging, 
    handleDrop,
    dragging
  } = useDragAndDrop();

  const handleSetDropZone = useCallback((e) => {
    e.preventDefault();
    if(!currentDragging || currentDragging?.node === node) return;
    if(props.element == ROW && currentDragging.el.element != COL) return;
    // Elements that only live inside one container (col → row, tab → tabs…).
    const requiredParent = elementsDict[currentDragging.el?.element]?.def?.parent;
    if (requiredParent && props.element !== requiredParent) return;

    setDropZone(node);
  }, [currentDragging, node, props.element, setDropZone]);

  const droppableEvents = useMemo(() => {
    if (!currentDragging) return {};
    return {
      onPointerEnter: handleSetDropZone,
      onPointerOver: handleSetDropZone,
      onPointerUp: handleDrop,
    };
  }, [currentDragging, handleSetDropZone, handleDrop]);

  const dragOver = useMemo(() => {
    return dragging && dropZone && dropZone === node &&
      (currentDragging && node !== currentDragging?.node)
  }, [dropZone, currentDragging, node, dragging]);

  const contextValue = useMemo(() => ({
    droppableEvents,
    droppable: true,
    dragOver,
    __REFS__,
  }), [droppableEvents, dragOver]);

  return (
    <DroppableContext.Provider value={contextValue}>
      {children}
    </DroppableContext.Provider>
  );
}