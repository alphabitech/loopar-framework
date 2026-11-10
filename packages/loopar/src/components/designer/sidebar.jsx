import { memo } from "react";
import { BrushIcon, EyeIcon, XIcon, SaveIcon, HandGrab, Undo2, Redo2 } from "lucide-react";
import { useDesigner } from "@context/designer-context";
import {Button as BaseButton} from "@cn/components/ui/button";
import {DesignerForm} from "./designer-form";
import {ElementEditor} from "./element-editor";
import {Separator} from "@cn/components/ui/separator";
import {useDocument} from "@loopar/document";
import { getNodeKey } from "@global/prune-doc-structure";
import { __ } from "@global/i18n";

function Button({...props}){
  return (
    <BaseButton {...props} className={`h-10 w-14 ${props.className}`}>
      {props.children}
    </BaseButton>
  )
}

export const Sidebar = memo(() => {
  const { handleSetSidebarOpen, sidebarOpen, docRef } = useDocument();
  const { handleChangeMode, designerModeType, updatingElement, dragEnabled, setDragEnable, undo, redo, canUndo, canRedo } = useDesigner();

  return (
    <div 
      className="w-sidebar-width mt-header-height pb-header-height bg-background dark:bg-background-dark border-l border-border dark:border-border-dark"
      style={{position: "fixed", top: 0, right: 0, zIndex: 30, width: 300, height: "100vh"}}
    >
      <div className="flex flex-col p-1 w-full h-full">
        <div className='flex items-center gap-1 pb-1'>
          <Button 
            size="icon" 
            variant="secondary"
            title={__("Undo (Ctrl+Z)")} 
            disabled={!canUndo} 
            onClick={undo}
          >
            <Undo2 className="h-5 w-5"/>
          </Button>
          <Button 
            size="icon" 
            variant="secondary"
            title={__("Redo (Ctrl+Shift+Z)")} 
            disabled={!canRedo} 
            onClick={redo}
          >
            <Redo2 className="h-5 w-5"/>
          </Button>
          <Button
            size="icon"
            variant="secondary"
            title={designerModeType === "preview" ? __("Design") : __("Preview")}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleChangeMode();
            }}
          >
            {designerModeType === "preview" ? <BrushIcon className="h-5 w-5"/> : <EyeIcon className="h-5 w-5"/>}
          </Button>
          {/* <Button
            size="icon"
            title="Drag"
            className={`${dragEnabled ? 'bg-red-500' : 'bg-secondary'}`}
            onClick={() => {
              setDragEnable && setDragEnable(!dragEnabled);
            }}
          >
            <HandGrab className="h-5 w-5"/>
          </Button> */}
          <Button
            size="icon"
            variant="secondary"
            title={__("Save")}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              docRef.save();
            }}
          >
            <SaveIcon className="h-5 w-5" />
          </Button>
          <Button
            size="icon"
            variant="secondary"
            className="ml-auto"
            title={__("Close")}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleSetSidebarOpen(false);
            }}
          >
            <XIcon className="h-5 w-5" />
          </Button>
        </div>
        <Separator/>
        <div
          style={{height: "calc(100% - 50px)", overflowY: "auto"}}
        >
          {
            designerModeType === "preview" ? (
              // The palette needs the drag-and-drop canvas, which preview
              // doesn't mount (it renders exactly what gets published).
              <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground">
                <EyeIcon className="h-6 w-6"/>
                <p>{__("Preview shows the page exactly as it will be published.")}</p>
                <BaseButton
                  variant="secondary"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleChangeMode();
                  }}
                >
                  <BrushIcon className="mr-2 h-4 w-4"/>
                  {__("Back to design")}
                </BaseButton>
              </div>
            ) : (designerModeType == "editor") ? (
              <ElementEditor key={getNodeKey(updatingElement)}/>
            ) : <DesignerForm/>
          }
        </div>
      </div>
    </div>
  );
});
