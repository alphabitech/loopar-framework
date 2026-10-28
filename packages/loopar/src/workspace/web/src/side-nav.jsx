import { SideNavItem } from "./side-nav-item";
import { menuPath } from "./main-nav";
import { useWorkspace } from "@workspace/workspace-provider";
import React, {useMemo} from "react";
import { cn } from "@cn/lib/utils";
import { Cross1Icon } from "@radix-ui/react-icons";
import { Item } from "@radix-ui/react-context-menu";

const getActive = (item, activePage) => {
  if (item.page == activePage) return true;

  for (const i of item.items) {
    if(getActive(i, activePage)){
      return true;
    }
  }

  return false;
}

const MenuItemTree = ({item, isChild = false}={item:Item, isChild:Boolean}) => {
  const { webApp, activePage } = useWorkspace();
  const menuItems = useMemo(() => webApp.menu_items, [webApp.menu_items]);
  
  const getParentLink = (parentLink) => {
    const parent = menuItems.find(item => item.link == parentLink);

    if (parent && parent.parent_menu) {
      return getParentLink(parent.parent_menu);
    }

    return parent?.link;
  }

  const getLink = (item) => {
    const parentLink = getParentLink(item.parent_menu);
    return parentLink ? `/${menuPath(parentLink)}/${menuPath(item.link)}` : `/${menuPath(item.link)}`;
  }

  const treeIsActive = getActive(item, activePage);

  return (
    <>
      <SideNavItem
        path={getLink(item)}
        title={item.link}
        className={`rounded-md pl-0 pt-0`}
        active={treeIsActive}
        hasChildren={item.items.length > 0}
        isChild={isChild}
        solid={webApp.solid}
      >
        <div className={cn("pl-3", !treeIsActive && "hidden")}>
          {item.items.filter(item => item.router_only != 1).sort((a, b) => a.id - b.id).map((subItem) => (
            <MenuItemTree key={subItem.page} item={subItem} isChild={true}/>
          ))}
        </div>
      </SideNavItem>
    </>
  );
};

const SideNavRender = ({ menu }) => {
  return (
    <div className="w-full">
      {menu.filter(item => item.router_only != 1).map((item) => (
        <MenuItemTree key={item.page} item={item}/>
      ))}
    </div>
  );
}

export function SideNav({sideMenuItems}) {
  const { openNav, setOpenNav, toogleSidebarNav, activeParentMenu, webApp } = useWorkspace();
  const baseClassName = `inset-0 z-50 overflow-y-auto bg-popover/90 border-r ${openNav ? 'w-web-sidebar-width px-2' : 'w-0'}`

  if (typeof window !== "undefined") {
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "k") {
        toogleSidebarNav()
      }
      if (e.key === "Escape") {
        setOpenNav()
      }
    })
  }

  const childMenuItems = sideMenuItems.find(item => item.page === activeParentMenu)?.items || [];

  return (
    <>
      <div className={cn("fixed", baseClassName, "lg:hidden")}>
        <>
          {openNav && (
            <>
              <div
                className="fixed inset-0 backdrop-blur-sm"
                onClick={() => setOpenNav(false)}
              />
              <button
                type="button"
                className="absolute right-5 top-1 z-10 flex h-8 w-8 items-center justify-center text-slate-500 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-300"
                tab-index="0"
                onClick={() => setOpenNav(false)}
              >
                <span className="sr-only">Close navigation</span>
                <Cross1Icon />
              </button>
            </>
          )}
          <div className="relative lg:text-sm lg:leading-6 pt-10 w-full">
            <SideNavRender menu={sideMenuItems} />
          </div>
        </>
      </div>
      <div className={cn("relative col-start-1 row-start-1 max-lg:hidden", childMenuItems.length === 0 && "hidden")}>
        <div className="absolute inset-0">
          <div
            className={"sticky top-web-header-height bottom-web-header-height left-0 max-h-[calc(100dvh-(var(--spacing)*14.25))] w-2xs overflow-y-auto p-2"}
          >
            <>
              <SideNavRender menu={childMenuItems} />
            </>
          </div>
        </div>
      </div>
    </>
  );
}