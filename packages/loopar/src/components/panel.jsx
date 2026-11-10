import { cn } from "@cn/lib/utils";
import {Droppable} from "@droppable";
import { useDesigner } from "@context/designer-context";
const DEFAULTS = {
  variant: "glass",
  rounded: "xl",
  padding: "md",
  bg_color: "primary",
  bg_opacity: "5",
  border_color: "primary",
  border_opacity: "20",
  border_width: "1",
  glow_color: "none",
  glow_opacity: "30",
  backdrop_blur: true,
  hoverable: true,
  focusable: true,
};

const variants = {
  glass: "backdrop-blur-xl",
  solid: "",
  gradient: "bg-gradient-to-br from-white/10 to-transparent",
  outline: "",
  glow: "",
};

const roundedSizes = {
  none: "rounded-none",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  "3xl": "rounded-3xl",
};

const paddingSizes = {
  none: "p-0",
  sm: "p-2",
  md: "p-4",
  lg: "p-6",
  xl: "p-8",
  "2xl": "p-10",
};

const colorVars = {
  primary: "var(--primary)",
  secondary: "var(--secondary)",
  accent: "var(--accent)",
  muted: "var(--muted)",
  card: "var(--card)",
  background: "var(--background)",
  foreground: "var(--foreground)",
  border: "var(--border)",
};

export default function MetaPanel(props) {
  const data = props.data || {};
  const { designing } = useDesigner();

  const config = { ...DEFAULTS, ...data };

  const buildStyle = () => {
    const style = {};

    if (config.bg_color !== "none") {
      const colorVar = colorVars[config.bg_color];
      const opacity = parseInt(config.bg_opacity) / 100;
      style.backgroundColor = `hsl(${colorVar} / ${opacity})`;
    }

    if (config.border_color !== "none") {
      const colorVar = colorVars[config.border_color];
      const opacity = parseInt(config.border_opacity) / 100;
      style.borderColor = `hsl(${colorVar} / ${opacity})`;
    }

    if (config.glow_color !== "none") {
      const colorVar = colorVars[config.glow_color];
      const opacity = parseInt(config.glow_opacity) / 100;
      style.boxShadow = `0 0 30px -5px hsl(${colorVar} / ${opacity})`;
    }

    return style;
  };

  const variant = variants[config.variant];
  const rounded = roundedSizes[config.rounded];
  const padding = paddingSizes[config.padding];
  
  const borderWidth = {
    "1": "border",
    "2": "border-2",
    "4": "border-4",
  }[config.border_width];
  
  const hasBorder = config.border_color !== "none";
  
  const hoverable = config.hoverable 
    ? "transition-all duration-300 hover:scale-[1.02] hover:brightness-110" 
    : "";
  const focusable = config.focusable 
    ? "focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2" 
    : "";
  const backdrop = config.backdrop_blur ? "backdrop-blur-xl" : "";

  const className = cn(
    props.className,
    variant,
    rounded,
    padding,
    hasBorder ? borderWidth : "",
    hoverable,
    focusable,
    backdrop,
    "w-full h-full transition-colors",
    config.class,
    designing && "p-2"
  );

  const hasHeader = data.title || data.description;

  if (!hasHeader) {
    return (
     <Droppable
        {...props}
        className={className}
        style={buildStyle()}
      />
    );
  }

  return (
    <div className={cn(className, "flex flex-col gap-4")} style={buildStyle()}>
      <div className="space-y-1.5">
        {data.title && <h3 className="text-2xl font-semibold leading-none tracking-tight">{data.title}</h3>}
        {data.description && <p className="text-sm text-muted-foreground">{data.description}</p>}
      </div>
      {/* Same stacking as a header-less panel (whose own className carries
          space-y-4): without it, consecutive rows inside touched. */}
      <Droppable {...props} className="flex-1 space-y-4" />
    </div>
  );
}


MetaPanel.metaFields = () => {
  const colorOptions = [
    { value: "none", label: "None" },
    { value: "primary", label: "Primary" },
    { value: "secondary", label: "Secondary" },
    { value: "accent", label: "Accent" },
    { value: "muted", label: "Muted" },
    { value: "card", label: "Card" },
    { value: "background", label: "Background" },
    { value: "foreground", label: "Foreground" },
    { value: "border", label: "Border" },
  ];

  const opacityOptions = ["5", "10", "20", "30", "40", "50", "60", "70", "80", "90", "100"]
    .map(v => ({ value: v, label: `${v}%` }));

  return [
    {
      group: "custom",
      elements: {
        title: {
          element: INPUT,
          data: { label: "Title", description: "Optional header shown above the content." },
        },
        description: {
          element: TEXTAREA,
          data: { label: "Description", rows: 2 },
        },
        variant: {
          element: SELECT,
          data: {
            label: "Variant",
            options: ["glass", "solid", "gradient", "outline", "glow"],
            default_value: DEFAULTS.variant,
          },
        },
        rounded: {
          element: SELECT,
          data: {
            label: "Rounded",
            options: ["none", "sm", "md", "lg", "xl", "2xl", "3xl"],
            default_value: DEFAULTS.rounded,
          },
        },
        padding: {
          element: SELECT,
          data: {
            label: "Padding",
            options: ["none", "sm", "md", "lg", "xl", "2xl"],
            default_value: DEFAULTS.padding,
          },
        },
      },
    },
    {
      group: "background",
      elements: {
        bg_color: { 
          element: SELECT, 
          data: { 
            label: "Color", 
            options: colorOptions, 
            default_value: DEFAULTS.bg_color,
          } 
        },
        bg_opacity: { 
          element: SELECT, 
          data: { 
            label: "Opacity", 
            options: opacityOptions, 
            default_value: DEFAULTS.bg_opacity,
          } 
        },
        backdrop_blur: { 
          element: SWITCH, 
          data: { 
            label: "Backdrop Blur",
            default_value: DEFAULTS.backdrop_blur,
          } 
        },
      },
    },
    {
      group: "border",
      elements: {
        border_color: { 
          element: SELECT, 
          data: { 
            label: "Color", 
            options: colorOptions, 
            default_value: DEFAULTS.border_color,
          } 
        },
        border_opacity: { 
          element: SELECT, 
          data: { 
            label: "Opacity", 
            options: opacityOptions, 
            default_value: DEFAULTS.border_opacity,
          } 
        },
        border_width: { 
          element: SELECT, 
          data: { 
            label: "Width", 
            options: ["1", "2", "4"], 
            default_value: DEFAULTS.border_width,
          } 
        },
      },
    },
    {
      group: "glow",
      elements: {
        glow_color: { 
          element: SELECT, 
          data: { 
            label: "Color", 
            options: colorOptions, 
            default_value: DEFAULTS.glow_color,
          } 
        },
        glow_opacity: { 
          element: SELECT, 
          data: { 
            label: "Intensity", 
            options: opacityOptions, 
            default_value: DEFAULTS.glow_opacity,
          } 
        },
      },
    },
    {
      group: "effects",
      elements: {
        hoverable: { 
          element: SWITCH, 
          data: { 
            label: "Hoverable",
            default_value: DEFAULTS.hoverable,
          } 
        },
        focusable: { 
          element: SWITCH, 
          data: { 
            label: "Focusable",
            default_value: DEFAULTS.focusable,
          } 
        },
      },
    },
  ];
};