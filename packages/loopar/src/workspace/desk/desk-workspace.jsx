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
            className={`flex flex-col flex-1 w-full px-4 pt-2 pb-4 overflow-auto duration-100 ease-in ${
              openNav ? "lg:!pl-sidebar-width" : "lg:!pl-collapse-sidebar-width"
            } ml-3 pr-3`}
          >
              {ActiveView}
          </div>
        </section>
      </div>
    </BaseWorkspace>
  )
}