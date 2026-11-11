import BaseWorkspace from "@workspace/base/base-workspace";
import { SideNav } from './src/side-nav';
import { TopNav } from "./src/top-nav";
import { useWorkspace } from "@workspace/workspace-provider";

export default function DeskWorkspace(props){
  const {openNav, ActiveView} = useWorkspace();
  const menuData = props.menuData || [];

  return (
    <BaseWorkspace menuData={menuData}>
      <div 
        className="vaul-drawer-wrapper flex flex-col min-h-screen"
      >
        <meta name="robots" content="noindex, nofollow"/>
        <div className="contents" data-print-hide>
          <TopNav openNav={openNav}></TopNav>
        </div>
        <section className="flex flex-col flex-1">
          <div className="contents" data-print-hide>
            <SideNav
              items={menuData}
            />
          </div>
         <div
            data-print-root
            className={`flex flex-col flex-1 min-w-0 px-4 pt-2 pb-4 overflow-auto ${
              openNav ? "lg:ml-sidebar-width" : "lg:ml-collapse-sidebar-width"
            }`}
          >
              {ActiveView}
          </div>
        </section>
      </div>
    </BaseWorkspace>
  )
}