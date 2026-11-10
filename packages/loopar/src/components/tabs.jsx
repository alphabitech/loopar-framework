"use strict";

import elementManage from "@@tools/element-manage";
import { Tabs as BaseTabs, TabsContent, TabsList, TabsTrigger } from "@cn/components/ui/tabs";
import { useDesigner } from "@context/designer-context";
import { useEffect, useMemo, useId } from "react";
import {usePersist} from "@services/persist-state";
import { Droppable } from "@droppable";
import { Trash2Icon, PlusIcon } from "lucide-react";
import {Button} from "@cn/components/ui/button";
import { getNodeKey } from "@global/prune-doc-structure";
import React from "react";
import { rootProps } from "./base/root-props.js";
import { cn } from "@cn/lib/utils";
import { ComponentDefaults } from "./base/ComponentDefaults.jsx";

const TabContent = ({element, parent, onDrop}) => {
  if(element.type === "dynamic.component"){
    return (
      <Droppable 
        Component={React.Fragment}
        {...element}
        key={null}
      />
    )
  }

  return <>{element.content}</>
}

function TabFn(props){
  const {id, elementsDict, node, data, asChild = false, canCustomize, setElements, parent} = props;

  const {designerMode, isDesigner, handleEditElement, handleDeleteElement} = useDesigner();
  const vertical = data?.orientation === "vertical";
  const underline = data?.variant === "underline";
  const getIdentifier = (id) => `${id}${designerMode ? '-designer' : ''}`;
  const getKey = (tab = {}) => {
    const tabData = tab.data || {};
    const id = tab.node || tabData.key || tabData.id || tabData.name;
    return getIdentifier(id);
  };

  const [currentTab, setCurrentTab] = usePersist(getIdentifier(id), getKey(elementsDict[0]));

  const selectFirstTab = () => {
    elementsDict.length > 0 && setCurrentTab(getKey(elementsDict[0]));
  }

  const checkIfTabExists = (key) => {
    return elementsDict.some(element => getKey(element) === key);
  }

  const addTab = () => {
    const [name, label] = [`tab_${elementManage.uuid()}`, `Tab ${elementsDict.length + 1}`];

    const tab = [
      {
        element: "tab",
        node: name,
        data: {
          name,
          id: name,
          label,
          droppable: true,
          draggable: false
        },
      },
    ];

    setElements(tab, () => {
      setCurrentTab(name);
    });
  }

  useEffect(() => {
    if (elementsDict.length === 0) {
      !asChild && designerMode && addTab();
      return;
    }
    if (!checkIfTabExists(currentTab)) selectFirstTab();
  }, [designerMode, id, currentTab, elementsDict]);

  useEffect(() => {
    !checkIfTabExists(currentTab) && selectFirstTab();
  }, []);

  const isCustomizable = useMemo(() => {
    return (typeof canCustomize == "undefined" ? true : canCustomize) && designerMode;
  }, [canCustomize, designerMode]);

  return (
    <BaseTabs 
      defaultValue={currentTab}
      value={currentTab}
      // Keyboard (arrows/Home/End) and assistive tech change tabs through Radix.
      onValueChange={setCurrentTab}
      orientation={vertical ? "vertical" : "horizontal"}
      className={cn("w-full", vertical && "flex flex-col gap-4 md:flex-row")}
    >
      <div className={cn("flex items-center justify-between overflow-x-auto overflow-y-hidden", vertical && "md:items-start md:overflow-visible")}>
        <TabsList className={cn(
          "inline-flex items-center gap-1 no-drag bg-transparent",
          vertical && "md:h-auto md:flex-col md:items-stretch",
          underline && "rounded-none border-b p-0",
          props.tabsClassName
        )}>
          {elementsDict.map((tab) => {
            const data = tab.data || {};
            const tabKey = getKey(tab);
            const editKey = tab.node || data.key;
            return (
              <TabsTrigger
                key={tabKey}
                value={tabKey}
                className={cn(
                  "flex items-center gap-2 !px-4 !min-h-[44px]",
                  vertical && "md:justify-start",
                  underline && "rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:shadow-none"
                )}
                onMouseDown={(e) => {
                  if (!designerMode) return;
                  // Designer: select the tab and open its properties without starting a drag.
                  e.preventDefault();
                  e.stopPropagation();
                  setCurrentTab(tabKey);
                  if (editKey) handleEditElement(editKey);
                }}
              >
                <span>{data.label}</span>
                {isCustomizable && (
                  <Trash2Icon
                    size={16}
                    className="text-red-500 hover:text-red-400 cursor-pointer"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      editKey && handleDeleteElement(editKey);
                    }}
                  />
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
        
        {isCustomizable && (
          <Button
            variant="default"
            size="icon"
            className="bg-primary !min-h-[44px] !min-w-[44px]"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              addTab(getIdentifier(id));
            }}
          >
            <PlusIcon size={16}/>
          </Button>
        )}
      </div>
      
      {elementsDict.map((element, index) => {
        const tabKey = getKey(element);
        return (
          <TabsContent key={tabKey} value={tabKey} className={cn("space-y-2", vertical && "md:mt-0 md:flex-1")}>
            <TabContent element={element} parent={parent + index}/>
          </TabsContent>
        );
      })}
    </BaseTabs>
  )
}

export default function MetaTabs(props){
  const {data, node, setElements} = ComponentDefaults(props);
  const key = useId();
  
  const elementsDict=useMemo(()=>{
    const elements = props.children || props.elements || [];

    return elements.map((element, index) => {
      if (element.$$typeof === Symbol.for("react.element") || element.$$typeof === Symbol.for("react.fragment") || element.$$typeof === Symbol.for("react.transitional.element")) {
        return {
          element: "tab",
          type: "react.element",
          node: element.props?.name || `${key}-${index}`,
          data: {
            name: element.props.name,
            label: element.props.label,
          },
          content: element.props.children,
        };
      } else {
        return {
          element: "tab",
          type: "dynamic.component",
          node: getNodeKey(element),
          data: element.data,
          elements: element.elements,
        };
      }
    });
  }, [props.children, props.elements, props.data]);

  const parentKey = node || data.key || data.id || data.name;

  return (
    <div {...rootProps(props)} className={cn("p-2 my-3 pt-0 mt-0 border border-separate", props.className)}>
      {data.label && <h4 className="p-2">{data.label}</h4>}
      <TabFn
        id={data.id || data.name || data.key || key}
        data={data}
        elementsDict={elementsDict}
        asChild={props.asChild}
        setElements={setElements}
        canCustomize={props.canCustomize}
        parent={parentKey}
        tabsClassName={props.tabsClassName}
      />
    </div>
  )
}

MetaTabs.requires = ["tab"]

MetaTabs.metaFields = () => [
  {
    group: "custom",
    elements: {
      variant: {
        element: SELECT,
        data: { label: "Style", options: [{ value: "pills", label: "Pills" }, { value: "underline", label: "Underline" }] },
      },
      orientation: {
        element: SELECT,
        data: { label: "Orientation", options: [{ value: "horizontal", label: "Horizontal" }, { value: "vertical", label: "Vertical (desktop)" }] },
      },
    },
  },
];