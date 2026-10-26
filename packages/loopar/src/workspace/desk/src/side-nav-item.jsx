import {Link} from "@link";
import { useWorkspace } from "@workspace/workspace-provider";
import { usePersist } from "@services/persist-state";
import { useEffect } from "react";
import {ChevronRightIcon} from "lucide-react"
import Icon from "@icon";

import { useLocation } from 'react-router';

const usePathname = () => {
  return useLocation();
};

export const SideNavItem = (props) => {
  const {
    external,
    icon,
    DefaultIcon,
    path,
    title,
    compact,
  } = props;

  const linkProps = path ? external : {};
  const { activeModule } = useWorkspace();
  // Visibility is decided server-side (WorkspaceController.sidebarData →
  // PermissionManager.canAccessModule): a module is in menu_data only when
  // the user can reach something inside it. No client-side award here — it
  // required a `Module.<x> view` grant that nothing seeds any more.
  
  const [active, setActive] = usePersist(path);

  const pathname = usePathname();

  useEffect(() => {
    const moduleName = decodeURIComponent(pathname?.pathname.split('/')[2]);
    setActive(moduleName === path || path == activeModule);
  }, [pathname, activeModule]);


  const link = compact ? (
    <Link
      award={false}
      to={`/desk/${path}`}
      className={`transition-duration-100 h-18 flex w-full flex-col justify-start space-y-0 rounded-full text-left align-middle transition-all h-auto ${props.className || ''}`}
      active={active}
      //activeClassName="bg-red-500 font-medium text-primary-foreground hover:bg-primary"
    >
      {icon ? <Icon data={{icon}} className="h-6 w-8 shrink-0"/> : <ChevronRightIcon className="h-6 w-8 shrink-0"/>}
      { title && (title.replace(" ", "-")).split('-').map((word, index) => (
        <small 
          key={path + index} 
          className="w-full truncate text-center h-auto"
        >
          {word}
        </small>
      ))}
    </Link>
  ) : null

  return compact ? link : (
    <Link
      award={false}
      className={`flex w-full items-center justify-start rounded py-1 text-left align-middle ${props.className || ''}`}
      {...linkProps}
      to={`/desk/${path}`}
      active={active}
    >
      {/* shrink-0: a long title would squeeze the icon to 0px in the flex row */}
      {icon ? <Icon data={{icon}} className="mr-2 h-6 w-6 shrink-0"/> : <ChevronRightIcon className="mr-2 h-6 w-6 shrink-0"/>}
      <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug" title={title}>{title}</span>
    </Link>
  );
};
