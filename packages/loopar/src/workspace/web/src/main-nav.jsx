import { Logo } from './logo';
import { HamburgerMenuIcon, Cross1Icon } from '@radix-ui/react-icons';
import { useWorkspace } from "@workspace/workspace-provider";
import { Link } from "@link";
import { useMemo } from "react";

/**
 * URL segment of a menu link: "About Us" → "about-us". The router matches
 * links ignoring case, spaces, dashes and underscores, so labels can be
 * written for people and still give clean addresses.
 */
export const menuPath = (link) => encodeURIComponent(String(link ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-"));

export function MainNav() {
  const { openNav, setOpenNav } = useWorkspace();
  const Icon = openNav ? Cross1Icon : HamburgerMenuIcon;

  const handleSetOpenNav = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenNav(!openNav);
  };

  return (
    <div className="flex min-w-[180px] items-center">
      <button onClick={handleSetOpenNav}>
        <Icon className="h-11 w-11 fill-current text-primary" />
      </button>
      <Logo variant="mobile" />
    </div>
  );
}

export function MenuItems({ half = null, className = "" }) {
  const { webApp, activeParentMenu } = useWorkspace();
  const menuItems = useMemo(
    () => (webApp.menu_items || []).filter(item => !item.parent_menu && !item.router_only),
    [webApp.menu_items]
  );
  const solid = useMemo(() => webApp.solid, [webApp.solid]);

  const rounded = useMemo(() => {
    return {
      sm: "rounded-sm",
      md: "rounded-md",
      lg: "rounded-lg",
      full: "rounded-full",
    }[webApp.rounded] || "rounded-md";
  }, [webApp.rounded]);

  const Items = useMemo(() => {
    let arr = menuItems;
    if (half === "first") {
      arr = menuItems.slice(0, Math.ceil(menuItems.length / 2));
    } else if (half === "second") {
      arr = menuItems.slice(Math.ceil(menuItems.length / 2));
    }

    return arr.map((item, i) => (
      <Link
        className={`transition-colors px-6 py-1 ${rounded} ${!solid && 'focus:bg-transparent hover:bg-transparent bg-transparent'}`}
        active={activeParentMenu === item.page}
        key={item.id + i}
        to={`/${menuPath(item.link)}`}
      >
        {item.link}
      </Link>
    ));
  }, [menuItems, half, activeParentMenu, solid, rounded]);

  return (
    <nav className={`flex flex-row items-center text-sm gap-2 ${className}`}>
      {Items}
    </nav>
  );
}
