import React from "react";
import BaseWorkspace from "@workspace/base/base-workspace";
import { SideNav } from './src/side-nav';
import { TopNav } from "./src/top-nav";
import { useWorkspace } from "@workspace/workspace-provider";
import { Markdown } from "@pure-html-block";
import TrafficTracker from "./src/traffic-tracker";
import { ANNOUNCEMENT_HEIGHT } from "./src/announcement-bar";
import { useState } from "react";

const SEO = () => {
  return <>
  <meta property="og:locale" content="en_US"/>
  <meta property="og:type" content="website"/>
  <meta charSet="utf-8"/>
  <meta name="generator" content="Loopar"/>
  <meta name="framework" content="Loopar"/>
  <meta name="cms" content="Loopar CMS"/>
  </>
}

const Layout = (({ ...props }) => {
  const { activeParentMenu, webApp, __META__ } = useWorkspace();
  // The site's announcement bar (above the navigation) until the visitor closes it.
  const [announcement, setAnnouncement] = useState(__META__.announcement || null);

  function buildMenuTree(menu) {
    const menuMap = {};

    menu.forEach(item => {
      menuMap[item.link] = { ...item, items: [] };
    });

    const menuTree = [];

    menu.forEach(item => {
      if (item.parent_menu) {
        if (menuMap[item.parent_menu]) {
          menuMap[item.parent_menu].items.push(menuMap[item.link]);
        } else {
          menuTree.push(menuMap[item.link]);
        }
      } else {
        menuTree.push(menuMap[item.link]);
      }
    });

    return menuTree;
  }

  const menuItemsTree = buildMenuTree(webApp.menu_items);
  const childMenu = menuItemsTree.find(item => item.page === activeParentMenu)?.items || [];

  const containerClass = childMenu.length > 0
    ? 'lg:grid-cols-[var(--container-2xs)_minmax(0,1fr)] xl:grid-cols-[var(--container-2xs)_minmax(0,1fr)]'
    : 'grid-cols-1 w-full';

  // Room for the fixed header: the navigation plus the announcement bar, if any.
  const className = `grid min-h-dvh w-full grid-rows-[1fr_auto] pt-[calc(var(--spacing-web-header-height)+var(--web-announcement-height))] ${containerClass}`;

  return (
    <div
      className="vaul-drawer-wrapper flex flex-col min-h-screen"
      style={{ "--web-announcement-height": announcement ? ANNOUNCEMENT_HEIGHT : "0px" }}
    >
      <SEO/>
      <TopNav menuActions={webApp.menu_actions} announcement={announcement} onCloseAnnouncement={() => setAnnouncement(null)} />
      <main className="flex-grow flex">
        <section
          className={className}
        >
          <SideNav sideMenuItems={menuItemsTree} childMenu={childMenu} />
          <div
            className={` relative row-start-1 grid ${childMenu.length > 0 ? 'grid-cols-subgrid lg:col-start-2' : 'col-span-12'}`}
          >
            <div className="grid grid-cols-1 min-h-[calc(100vh-var(--spacing-web-header-height))]">
              {props.children}
            </div>
          </div>
          <footer className="row-start-2 col-start-1 col-span-full py-6 border-t w-full bg-gradient-to-t to-transparent from-secondary">
            <div className="flex flex-col w-full gap-0">
              {webApp.has_footer && (
                <div className="w-full">
                  <Markdown content={webApp.footer}/>
                </div>
              )}
              {webApp.has_copyright && (
                <div className="w-full">
                  <Markdown content={webApp.copyright}/>
                </div>
              )}
            </div>
          </footer>
        </section>
      </main>
    </div>
  );
});

export default function WebWorkspace(props) {
  const { ActiveView, __META__ } = useWorkspace();

  const getWebApp = () => {
    return __META__.web_app || {};
  }

  const activePage = __META__.Document.Entity.name;

  return (
    <BaseWorkspace activePage={activePage} webApp={getWebApp()}>
      <TrafficTracker page={activePage} />
      <Layout {...props}>
        {ActiveView}
      </Layout>
    </BaseWorkspace>
  )
}