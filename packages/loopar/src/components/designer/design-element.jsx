import elementManage from "@@tools/element-manage";
import loopar from "loopar";
import { useRef } from "react";
import { useDragAndDrop } from "../droppable/DragAndDropContext";
import Icon from "@icon";
import { elementsDict } from "@global/element-definition";

export function DesignElement(props){
  const element = props.element;
  const draggableRef = useRef();
  const {setCurrentDragging, setInitializedDragging} = useDragAndDrop();
  const toElement =  element.element;

  const elementToCreate = () => {
    const { key, label } = elementManage.elementName(toElement);
    // Only fields get a starting label ("Input3"); content elements start
    // empty — their texts are their own props (title, text…).
    const writable = elementsDict[toElement]?.def?.isWritable;

    return {
      element: toElement,
      node: key,
      data: writable ? { label } : {},
    }
  }

  const className = "w-full bg-card/70 rounded transition-colors";

  const dragStart = (e) => {
    const el = elementToCreate();
    const rect = draggableRef.current.getBoundingClientRect();
    setInitializedDragging(true);

    setCurrentDragging({
      isNew: true,
      node: el.node,
      el,
      ref: draggableRef.current,
      initialPosition: {
        x: e.clientX,
        y: e.clientY,
      },
      offset: {
        x: e.clientX - rect.x,
        y: e.clientY - rect.y,
      },
      size: {
        width: rect.width,
        height: rect.height,
      },
      className: className + " mb-4",
    });
  };

  return (
    <div 
      className={className}
      ref={draggableRef}
      onPointerDown={dragStart}
    >
      <a
        className="flex w-full flex-col items-center rounded border p-2 shadow cursor-pointer transition-colors hover:bg-muted/50"
      >
        <Icon data={{icon: element.icon}} className="w-8 h-8"/>
        <small className="text-muted-foreground truncate text-center w-full user-select-none">
          {loopar.utils.humanize(element.element)}
        </small>
      </a>
    </div>
  )
}