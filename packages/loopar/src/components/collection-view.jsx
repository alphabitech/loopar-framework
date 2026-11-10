import { useMemo } from "react";
import DefaultDetail from "./collection/default-detail.jsx";
import { __ } from "@global/i18n";
import { entityPicker } from "./base/entity-pickers.js";

const detailModules = import.meta.glob("./*-detail.jsx", { eager: true });

function lookupDetail(entityName) {
  if (!entityName) return DefaultDetail;
  const slug = String(entityName)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
  return detailModules[`./${slug}-detail.jsx`]?.default || DefaultDetail;
}

export default function CollectionView({ data = {} }) {
  const entityName = data.options ? String(data.options).trim() : null;
  const preloaded = data.preloaded;
  const layout = data.detail_layout || "page";
  const Detail = useMemo(() => lookupDetail(entityName), [entityName]);

  if (!entityName) {
    return (
      <section className="w-full py-16 px-4 min-h-section-min">
        <div className="max-w-3xl mx-auto text-center text-sm text-muted-foreground">
          {__("Collection view has no entity configured.")}
        </div>
      </section>
    );
  }

  const item = preloaded?.mode === "detail" ? preloaded.item : null;
  const fields = preloaded?.fields || [];
  const enableComments = [1, "1", true, "true"].includes(data.enable_comments);

  return (
    <Detail
      entity={entityName}
      fields={fields}
      preloadedItem={item}
      slug={item?.slug || null}
      app={data.app}
      layout={layout}
      enableComments={enableComments}
      galleryMode={data.gallery_mode || "carousel"}
      galleryColumns={data.gallery_columns || 3}
      backLabel={data.back_label || "Back"}
      backHref={data.back_href || "."}
      onBack={(href, e) => {
        if (typeof window === "undefined") return;
        e?.preventDefault?.();
        window.history.back();
      }}
    />
  );
}

CollectionView.metaFields = () => {
  return [
    {
      group: "custom",
      elements: {
        options: entityPicker({ label: "Entity", description: "Backing entity (Project / Service / …)." }),
        detail_layout: {
          element: SELECT,
          data: {
            label: "Detail layout",
            options: "page\ngallery\narticle",
            description: "page: cover hero + metadata table + gallery. gallery: hero with carousel. article: single reading column for long-form content. An <entity>-detail.jsx override takes precedence.",
          },
        },
        gallery_mode: {
          element: SELECT,
          data: {
            label: "Gallery mode",
            options: "carousel\ngrid",
          },
        },
        gallery_columns: {
          element: INPUT,
          data: { label: "Gallery columns (grid, 1–4)", format: "int" },
        },
        back_label: {
          element: INPUT,
          data: { label: "Back link text" },
        },
        enable_comments: {
          element: SWITCH,
          data: {
            label: "Enable comments",
            description: "Show a public comments section on the detail page. Guest comments are held for approval.",
          },
        },
      },
    },
  ];
};
