import {cn} from "@cn/lib/utils";
import Icon from "@icon"; 

export default function FeatureCard(props) {
  const data = props.data;
  const {
    label,
    text,
    align = "start",
    image_height = "h-64",
    overlay_intensity = "medium",
    hover_effect = true,
    content_position = "outside",
    // Fallbacks below mirror the metaFields default_value declarations —
    // metaFields is the source of truth (hydrated centrally in Meta.jsx via
    // applyMetaDefaults); these only guard direct/legacy renders.
    icon = "BadgeCheck",
    icon_size = "lg",
    icon_opacity = "soft",
    variant = "default"
  } = data;

  const { backgroundImage, ...restStyle } = props.style || {};
  const hasIcon = icon && !backgroundImage;
  const hasImage = backgroundImage;

  const overlayMap = {
    none: "bg-black/0",
    light: "bg-black/10 dark:bg-black/20",
    medium: "bg-black/20 dark:bg-black/40",
    strong: "bg-black/40 dark:bg-black/60"
  };

  const alignMap = {
    start: "text-left items-start",
    center: "text-center items-center",
    end: "text-right items-end"
  };

  const iconOpacityMap = {
    "10": "text-primary/10",  "subtle":  "text-primary/10",
    "20": "text-primary/20",  "soft":    "text-primary/20",
    "30": "text-primary/30",  "medium":  "text-primary/30",
    "40": "text-primary/40",  "visible": "text-primary/40",
    "50": "text-primary/50",  "strong":  "text-primary/50"
  };

  const iconHoverOpacityMap = {
    "10": "group-hover:text-primary/20",  "subtle":  "group-hover:text-primary/20",
    "20": "group-hover:text-primary/30",  "soft":    "group-hover:text-primary/30",
    "30": "group-hover:text-primary/40",  "medium":  "group-hover:text-primary/40",
    "40": "group-hover:text-primary/50",  "visible": "group-hover:text-primary/50",
    "50": "group-hover:text-primary/60",  "strong":  "group-hover:text-primary/60"
  };

  const iconSizeMap = {
    "64":   { class: "w-16 h-16", px: 64 },   "sm":   { class: "w-16 h-16", px: 64 },
    "80":   { class: "w-20 h-20", px: 80 },   "md":   { class: "w-20 h-20", px: 80 },
    "96":   { class: "w-24 h-24", px: 96 },   "lg":   { class: "w-24 h-24", px: 96 },
    "128":  { class: "w-32 h-32", px: 128 },  "xl":   { class: "w-32 h-32", px: 128 },
    "full": { class: "w-full h-full p-8",     px: null }
  };
  const iconSizeEntry = iconSizeMap[icon_size] || iconSizeMap["96"];

  const variantStyles = {
    default: {
      wrapper: "rounded-xl bg-card border hover:border-primary/50 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/30",
      imageBox: hasImage ? "m-4" : "",
      contentWrap: "p-6 bg-card",
      titleClass: "text-lg font-semibold text-foreground",
      textClass: "text-muted-foreground text-sm leading-relaxed",
      bottomGradient: true
    },
    elevated: {
      wrapper: "rounded-2xl bg-card border-2 border-border/70 shadow-md hover:-translate-y-1 hover:shadow-2xl hover:shadow-primary/10 hover:border-primary/40 dark:hover:shadow-black/40",
      imageBox: hasImage ? "rounded-t-2xl" : "",
      contentWrap: "p-6 bg-card rounded-b-2xl",
      titleClass: "text-xl font-bold text-foreground tracking-tight",
      textClass: "text-muted-foreground text-sm leading-relaxed",
      bottomGradient: false
    }
  };

  const v = variantStyles[variant] || variantStyles.default;

  const className = cn(
    "group relative overflow-hidden h-full transition-all duration-300",
    v.wrapper,
    props.className
  );

  // Content laid over the image always sits on the dark overlay/gradient, so it
  // must use light text regardless of the theme (light mode would otherwise
  // render foreground-colored text on a dark photo).
  const onImage = content_position === "overlay" && hasImage;

  const Content = () => (
    <div className={cn("flex flex-col gap-2", alignMap[align])}>
      <h3 className={cn(v.titleClass, onImage && "!text-white drop-shadow-sm")}>{label}</h3>
      <p className={cn(v.textClass, onImage && "!text-white/85")}>{text}</p>
    </div>
  );

  const IconBackground = () => (
    <div className={cn(
      "absolute inset-0 flex items-center justify-center",
      "bg-gradient-to-br from-primary/5 via-transparent to-primary/10"
    )}>
      <Icon
        data={{icon:icon}}
        name={icon}
        {...(iconSizeEntry.px != null ? { size: iconSizeEntry.px } : {})}
        className={cn(
          iconSizeEntry.class,
          iconOpacityMap[icon_opacity],
          "transition-all duration-500",
          hover_effect && "group-hover:scale-110",
          hover_effect && iconHoverOpacityMap[icon_opacity]
        )}
        strokeWidth={1}
      />
    </div>
  );

  return (
    <div 
      {...props}
      style={restStyle}
      className={className}
    >
      <div
        className={cn(
          "relative overflow-hidden",
          image_height,
          hasImage && "bg-cover bg-center",
          hasImage && v.imageBox,
          hasIcon && "bg-muted/30",
          hasIcon && v.imageBox,
          hover_effect && hasImage && "transition-transform duration-500 group-hover:scale-105"
        )}
        style={hasImage ? props.style : undefined}
      >
        {hasIcon && <IconBackground />}

        {hasImage && (
          <div className={cn("absolute inset-0", overlayMap[overlay_intensity])} />
        )}

        {(v.bottomGradient || onImage) && (
          <div className={cn(
            "absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t to-transparent",
            content_position === "outside" ? "from-card" : "from-black/80"
          )} />
        )}

        {content_position === "overlay" && (
          <div className="absolute bottom-0 left-0 right-0 p-6 text-white">
            <Content />
          </div>
        )}
      </div>

      {content_position === "outside" && (
        <div className={v.contentWrap}>
          <Content />
        </div>
      )}
    </div>
  );
}

FeatureCard.metaFields = () => {
  return [{
    group: "custom",
    elements: {
      variant: {
        element: SELECT,
        data: {
          label: "Card Variant",
          description: "Visual style. Default keeps existing look. Elevated adds baseline shadow, lift on hover, edge-to-edge image, larger title.",
          options: [
            { value: "default", label: "Default" },
            { value: "elevated", label: "Elevated" }
          ],
          default_value: "default"
        }
      },
      icon: {
        element: ICON_INPUT,
        data: {
          label: "Icon",
          description: "Lucide icon name (e.g., Network, Database, Zap)",
          default_value: "BadgeCheck"
        }
      },
      icon_size: {
        element: SELECT,
        data: {
          label: "Icon Size",
          description: "Use semantic sizes. 'Fill' makes the icon expand to the parent container.",
          options: [
            { value: "sm",   label: "Small" },
            { value: "md",   label: "Medium" },
            { value: "lg",   label: "Large" },
            { value: "xl",   label: "Extra Large" },
            { value: "full", label: "Fill Container" }
          ],
          default_value: "lg"
        }
      },
      icon_opacity: {
        element: SELECT,
        data: {
          label: "Icon Opacity",
          options: [
            { value: "subtle",  label: "Very Subtle" },
            { value: "soft",    label: "Subtle" },
            { value: "medium",  label: "Medium" },
            { value: "visible", label: "Visible" },
            { value: "strong",  label: "Strong" }
          ],
          default_value: "soft"
        }
      },
      align: {
        element: SELECT,
        data: {
          label: "Text Align",
          options: [
            { value: "start",  label: "Start" },
            { value: "center", label: "Center" },
            { value: "end",    label: "End" }
          ],
          default_value: "start"
        }
      },
      image_height: {
        element: SELECT,
        data: {
          label: "Image / Icon Box Height",
          options: [
            { value: "h-32", label: "Small" },
            { value: "h-48", label: "Medium" },
            { value: "h-64", label: "Large" },
            { value: "h-80", label: "XLarge" },
            { value: "h-96", label: "Full" }
          ],
          default_value: "h-64"
        }
      },
      overlay_intensity: {
        element: SELECT,
        data: {
          label: "Overlay Intensity",
          options: [
            { value: "none",   label: "None" },
            { value: "light",  label: "Light" },
            { value: "medium", label: "Medium" },
            { value: "strong", label: "Strong" }
          ],
          default_value: "medium"
        }
      },
      content_position: {
        element: SELECT,
        data: {
          label: "Content Position",
          options: [
            { value: "outside", label: "Outside (Footer)" },
            { value: "overlay", label: "Overlay (On Image)" }
          ],
          default_value: "outside"
        }
      },
      hover_effect: {
        element: SWITCH,
        data: {
          label: "Hover Zoom Effect",
          default_value: true
        }
      }
    }
  }];
};