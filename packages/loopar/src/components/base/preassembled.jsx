import { ComponentDefaults } from "./ComponentDefaults";
import {Droppable} from "@droppable";
import {useDesigner} from "@context/designer-context";
import { useEffect, useId, createContext, useContext} from "react";

const PreassembledContext = createContext({
  props: {},
  elements: []
})

export const usePreassembledContext = () => useContext(PreassembledContext);

export const PreassembledContextProvider = (props) => {
  const { setElements } = ComponentDefaults(props);
  const { designerMode } = useDesigner();
  
  const data = props.data || {};
  const id = useId();

  useEffect(() => {
    if(!designerMode) return;
    let counter = 0;

    if (!props.elements || props.elements?.length === 0) {
      const prepareElements = (elements) => {
        return elements.map(el => {
          counter ++;
          el.data ??= {};
          el.node ??= id + counter;

          if (el.elements?.length > 0) {
            el.elements = prepareElements(el.elements);
          }
          return el;
        });
      }

      setElements(prepareElements(props.defaultElements || []), null, false);
    }
  }, [data, props.elements]);

  return (
    <PreassembledContext.Provider value={{
      props: props
    }}>
      {props.children}
    </PreassembledContext.Provider>
  );
}

export default function Preassembled(props) {
  if(props.desacopled){
    return (
      props.notDroppable ? <><div {...props}/>{props.children}</> :
      <><Droppable {...props}/>{props.children}</>
    )
  }

  return props.notDroppable ? <div {...props}>{props.children}</div> : <Droppable {...props}>{props.children}</Droppable>
}
