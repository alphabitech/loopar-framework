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
import { isExternalTarget, safeTarget } from "@global/link-target";
import { EntryModal } from "@app/entry-modal";
import { currentLanguage, localizePath } from "@global/i18n";
import { DynamicIcon } from "@icon";

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
  to: rawTo = "",
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
  target: targetProp,
  // `_target` is the designer's field name (see metaFields); "_modal" is ours,
  // never a DOM target.
  _target,
  ...props
}) {
  const { setOpenNav, currentPage, workspace, award, navigate: wsNavigate, isModal } = useWorkspace();
  const [modalOpen, setModalOpen] = useState(false);
  const { designing } = useDesigner();

  // The target is authored in a designer: only navigable schemes are followed.
  const to = safeTarget(rawTo);
  const url = useMakeUrl(to);

  const isAbsolute = isExternalTarget(to);
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
        // Drop only the bare `text-primary` token (the "link" variant's color):
        // a substring replace also mangled `text-primary-foreground` into
        // `-foreground`, so primary/default links lost their text color.
        const classVariant = buttonVariants({ variant, size }).replace(/(^|\s)text-primary(?=\s|$)/g, "$1");
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
    // An external page cannot open in a desk modal: it opens normally.
    const chosen = targetProp || _target;
    const target = chosen === "_modal" ? undefined : chosen;
    return (
      <a
        {...commonProps}
        href={to}
        {...(target ? { target } : {})}
        {...(target === "_blank" ? { rel: "noopener noreferrer" } : {})}
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
      {...((targetProp || _target) === "_blank" ? { target: "_blank" } : {})}
      onClick={handleClick}
      key={renderizableProps.key || url}
    >
      {children}
    </ReactLink>
  );
}

export const BUTTON_SIZES = [
  { value: "default", label: "Default" },
  { value: "sm", label: "Small" },
  { value: "lg", label: "Large" },
];

/** Label with an optional icon before/after it (links and buttons). */
export function IconLabel({ icon, position = "start", children }) {
  if (!icon) return children;
  const glyph = <DynamicIcon icon={{ value: icon }} className="size-4 shrink-0" />;
  return (
    <span className="inline-flex items-center gap-2">
      {position !== "end" && glyph}
      {children}
      {position === "end" && glyph}
    </span>
  );
}

export const iconMetaFields = () => ({
  icon: { element: ICON_INPUT, data: { label: "Icon" } },
  icon_position: {
    element: SELECT,
    data: {
      label: "Icon Position",
      options: [{ value: "start", label: "Before text" }, { value: "end", label: "After text" }],
    },
  },
  size: { element: SELECT, data: { label: "Size", options: BUTTON_SIZES } },
});

export default function MetaLink({...props}) {
  const data = props.data || {};
  // Permission display is the framework's call, never the structure's:
  // `award` / `renderOnRestrict` cannot be set from designer data.
  const { class: dataClass, icon, icon_position, size, award, renderOnRestrict, ...restData } = data;

  return (
    <Link
      {...props}
      {...restData}
      inModal={restData._target === "_modal" || props.inModal}
      size={BUTTON_SIZES.some(s => s.value === size) ? size : undefined}
      className={cn(props.className, dataClass)}
      variant={VARIANTS[data.variant] || VARIANTS.default}
      key={props.node || data.key || props.to}
    >
      <IconLabel icon={icon} position={icon_position}>{data.label || props.children}</IconLabel>
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
          { value: "_self",  label: "Same page" },
          { value: "_blank", label: "New tab" },
          { value: "_modal", label: "Modal (desk)" },
        ],
      },
    },
    variant: {
      element: SELECT,
      data: {
        options: Object.keys(VARIANTS).map(k => ({ value: VARIANTS[k], label: k })),
      },
    },
    ...iconMetaFields(),
  },
}];