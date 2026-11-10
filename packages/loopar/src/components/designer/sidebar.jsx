import { memo } from "react";
import { BrushIcon, EyeIcon, XIcon, SaveIcon, HandGrab, Undo2, Redo2, Plus, ListTree, SlidersHorizontal, Maximize2 } from "lucide-react";
import { cn } from "@cn/lib/utils";
import { Navigator } from "./navigator";
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
  const { handleChangeMode, designerModeType, updatingElement, dragEnabled, setDragEnable, undo, redo, canUndo, canRedo, sidebarView, setSidebarView, previewInline, openPreview } = useDesigner();

  const preferred = sidebarView ?? (designerModeType === "editor" ? "properties" : "elements");
  const view = preferred === "properties" && !updatingElement ? "elements" : preferred;

  const VIEWS = [
    { name: "elements", label: __("Elements"), Icon: Plus },
    { name: "navigator", label: __("Navigator"), Icon: ListTree },
    { name: "properties", label: __("Properties"), Icon: SlidersHorizontal, disabled: !updatingElement },
  ];

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
            title={previewInline ? __("Design") : __("Preview")}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleChangeMode();
            }}
          >
            {previewInline ? <BrushIcon className="h-5 w-5"/> : <EyeIcon className="h-5 w-5"/>}
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
        {!previewInline && <div role="tablist" className="grid grid-cols-3 gap-1 py-1">
          {VIEWS.map(({ name, label, Icon, disabled }) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={view === name}
              disabled={disabled}
              title={label}
              className={cn(
                "flex min-w-0 items-center justify-center gap-1 rounded-md px-1 py-1.5 text-xs font-medium transition-colors",
                view === name ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                disabled && "pointer-events-none opacity-40"
              )}
              onClick={() => setSidebarView(name)}
            >
              <Icon className="h-3.5 w-3.5 shrink-0"/>
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {
            previewInline ? (
              // The palette needs the drag-and-drop canvas, which the preview
              // doesn't mount (it renders what gets published).
              <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground">
                <EyeIcon className="h-6 w-6"/>
                <p>{__("Preview renders the page as it will be published, in the designer's own width.")}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <BaseButton variant="secondary" onClick={() => handleChangeMode()}>
                    <BrushIcon className="mr-2 h-4 w-4"/>
                    {__("Back to design")}
                  </BaseButton>
                  <BaseButton variant="secondary" onClick={openPreview}>
                    <Maximize2 className="mr-2 h-4 w-4"/>
                    {__("Full screen")}
                  </BaseButton>
                </div>
              </div>
            ) : view === "navigator" ? (
              <Navigator/>
            ) : view === "properties" ? (
              <ElementEditor key={getNodeKey(updatingElement)}/>
            ) : <DesignerForm/>
          }
        </div>
      </div>
    </div>
  );
});
