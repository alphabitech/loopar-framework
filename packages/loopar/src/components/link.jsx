import loopar from "loopar";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Link as ReactLink } from 'react-router';
import { cn } from "@cn/lib/utils";
import { buttonVariants } from "@cn/components/ui/button";
import { useWorkspace } from "@workspace/workspace-provider";
import { activeLink } from "@workspace/defaults";
import { useDesigner } from "@context/designer-context";
import { VARIANTS } from "./base/ComponentDefaults";
import { RouteParsing, setDefaultParams, buildUrl } from "@global/router-utils";
import { EntryModal } from "@app/entry-modal";
import { currentLanguage, localizePath } from "@global/i18n";

const HEADER_OFFSET = 15;

const parseParams = (pathname, workspaceName = 'desk') =>
  RouteParsing.parseParams(pathname, workspaceName);

export const useMakeUrl = (href) => {
  const { pathname, workspace, __META__ } = useWorkspace();
  const site = __META__?.site_languages;

  return useMemo(() => {
    const url = buildUrl(href, pathname);
    // Website links stay in the visitor's language (/es/pricing).
    return workspace === "web" && site ? localizePath(url, currentLanguage(), site) : url;
  }, [href, pathname, workspace, site]);
};

export const makeUrl = (href) => {
  if (!href || href.startsWith("http") || href.startsWith("/")) return href;
  const currentURL = global.url || (typeof window !== 'undefined' ? window.location.pathname : '');
  return buildUrl(href, currentURL);
};

const useHeaderHeight = () => {
  return useCallback(() => {
    const header = document.querySelector('header');
    return header ? parseFloat(getComputedStyle(header).height) : 0;
  }, []);
};

const useScrollToSection = (to) => {
  const getHeaderHeight = useHeaderHeight();
  return useCallback(() => {
    if (!to.startsWith("#")) return;
    const target = document.getElementById(to.substring(1));
    if (!target) return;
    const offsetTop = target.getBoundingClientRect().top + window.scrollY - getHeaderHeight();
    window.scrollTo({ top: offsetTop - HEADER_OFFSET, behavior: 'smooth' });
  }, [to, getHeaderHeight]);
};

const useActiveSection = (to, enabled) => {
  const [active, setActive] = useState(null);
  const getHeaderHeight = useHeaderHeight();
  const { pathname } = useWorkspace();

  const detectActiveSection = useCallback(() => {
    const scroll = window.scrollY + getHeaderHeight();
    let activeSection = null;
    let minDistance = Infinity;

    document.querySelectorAll('[id][data-section]').forEach(section => {
      const top = section.offsetTop;
      const height = section.offsetHeight;
      const distance = Math.abs(top - scroll);

      if (
        distance <= minDistance &&
        ((top <= scroll && top + height > scroll) ||
         (top + height <= scroll + window.innerHeight && top >= scroll) ||
         (scroll >= top && scroll < top + height))
      ) {
        minDistance = distance;
        activeSection = section.id;
      }
    });

    setActive(activeSection);
  }, [getHeaderHeight]);

  useEffect(() => {
    if (!enabled) return;
    const id = setTimeout(detectActiveSection, 100);
    window.addEventListener("scroll", detectActiveSection, { passive: true });
    return () => {
      window.removeEventListener("scroll", detectActiveSection);
      clearTimeout(id);
    };
  }, [enabled, detectActiveSection, pathname]);

  return active;
};

export function Link({
  to = "",
  inModal,
  onSaved,
  variant = "link",
  size,
  children,
  notControlled,
  activeClassName,
  onClick,
  bare = false,
  award: awardProp,
  active: activeProp,
  renderOnRestrict,
  ...props
}) {
  const { setOpenNav, currentPage, workspace, award, navigate: wsNavigate, isModal } = useWorkspace();
  const [modalOpen, setModalOpen] = useState(false);
  const { designing } = useDesigner();

  const url = useMakeUrl(to);

  const isAbsolute = url?.includes("http");
  const isHashLink = to.startsWith("#");

  const scrollToSection = useScrollToSection(to);
  const activeSection = useActiveSection(to, isHashLink);

  const params = useMemo(() => {
    if (!url) return { document: '', action: 'view' };
    return setDefaultParams(parseParams(url, workspace), workspace);
  }, [url, workspace]);

  const canRender = useMemo(() => {
    if (awardProp === false || workspace != "desk" || isAbsolute) return true;
    
    const doc = params.document?.toLowerCase().replaceAll(" ", "") ?? '';
    const action = params.action ?? 'view';

    return award(doc, action, false);
  }, [params, award, awardProp, workspace, url, to]);

  const handleClick = useCallback((e) => {
    if (isHashLink) {
      e.preventDefault();
      scrollToSection();
      return;
    }
    onClick?.(e);
    if (workspace === "web") setOpenNav(false);
  }, [isHashLink, scrollToSection, onClick, workspace, setOpenNav]);

  const isActive = useMemo(() => {
    if (activeProp) return true;
    return currentPage && currentPage === to;
  }, [activeProp, to, currentPage]);

  if (!canRender && !renderOnRestrict) return null;

  // `bare` opts out of the shadcn button styling — useful when the Link
  // is a wrapper around custom content (cards, image tiles, sections) and
  // the caller wants full control of the visual. Without it, the Link
  // forces inline-flex + button paddings that flatten any vertical layout
  // inside.
  const className = bare
    ? cn(
        canRender && !renderOnRestrict && activeLink(isActive, activeClassName),
        props.className,
      )
    : (() => {
        const classVariant = buttonVariants({ variant, size }).replaceAll("text-primary", "");
        return cn(
          "justify-normal cursor-pointer p-2",
          canRender && !renderOnRestrict && activeLink(isActive, activeClassName),
          classVariant,
          "justify-start",
          props.className,
        );
      })();

  const renderizableProps = loopar.utils.renderizableProps(props);
  const commonProps = {
    ...renderizableProps,
    className,
    ...(designing && { draggable: false }),
  };

  if(props.disabled || onClick){
    return <button {...commonProps} onClick={handleClick} className={className} disabled={props.disabled}>{children}</button>
  }

  if (isAbsolute || notControlled) {
    // `_target` is the designer's field name (see metaFields) — translate it
    // to the real DOM attribute instead of leaking `_target` into the <a>.
    const target = props.target || props._target;
    return (
      <a
        {...commonProps}
        href={to}
        {...(target ? { target } : {})}
        key={renderizableProps.key || to}
      >
        {children}
      </a>
    );
  }

  if(!canRender && renderOnRestrict){
    return <div {...commonProps} disabled={true}>
      {children}
    </div>
  }

  if (inModal) {
    // This link OPENS its target in a modal (a mini-workspace booted from the
    // URL). Plain left-click opens; modified clicks fall through to the <a>.
    return (
      <>
        <a
          {...commonProps}
          href={url}
          onClick={(e) => {
            if (!e.defaultPrevented && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
              e.preventDefault();
              setModalOpen(true);
            }
            handleClick(e);
          }}
          key={renderizableProps.key || url}
        >
          {children}
        </a>
        {modalOpen && <EntryModal initialPath={url} onClose={() => setModalOpen(false)} onSaved={onSaved} />}
      </>
    );
  }

  if (isModal) {
    // Inside a modal: navigate the modal's in-memory path on a plain
    // left-click; let modified clicks (new tab, middle-click) use the <a>.
    return (
      <a
        {...commonProps}
        href={url}
        onClick={(e) => {
          if (!e.defaultPrevented && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
            e.preventDefault();
            wsNavigate(url);
          }
          handleClick(e);
        }}
        key={renderizableProps.key || url}
      >
        {children}
      </a>
    );
  }

  return (
    <ReactLink
      {...commonProps}
      to={url}
      onClick={handleClick}
      key={renderizableProps.key || url}
    >
      {children}
    </ReactLink>
  );
}

export default function MetaLink({...props}) {
  const data = props.data || {};
  const { class: dataClass, ...restData } = data;

  return (
    <Link
      {...props}
      {...restData}
      className={cn(props.className, dataClass)}
      variant={VARIANTS[data.variant] || VARIANTS.default}
      key={props.node || data.key || props.to}
    >
      {data.label || props.children}
    </Link>
  );
}

MetaLink.metaFields = () => [{
  group: "form",
  elements: {
    to: { element: INPUT },
    _target: {
      element: SELECT,
      data: {
        options: [
          { option: "self",  value: "_self"  },
          { option: "blank", value: "_blank" },
        ],
      },
    },
    variant: {
      element: SELECT,
      data: {
        options: Object.keys(VARIANTS).map(k => ({ value: VARIANTS[k], label: k })),
      },
    },
  },
}];