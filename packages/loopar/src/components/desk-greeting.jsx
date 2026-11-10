import { cn } from "@cn/lib/utils";
import { useDeskElement } from "@loopar/components/desk/use-desk-element";
import { __, currentLanguage } from "@global/i18n";

const greetingFor = (hour) =>
  hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

/**
 * Desk page element: "Good evening, Alfredo" + company and today's date. The
 * time of day is the viewer's own clock; name and company come from the
 * server (core/document/desk-home.js).
 */
export default function DeskGreeting(props) {
  const data = props.data || {};
  const { designing, loading, data: result } = useDeskElement(props.node);
  if (result?.denied) return null;

  const now = new Date();
  const name = designing ? "Alfredo" : result?.name;
  const company = designing ? "My Company" : result?.company;
  let today = "";
  try {
    today = now.toLocaleDateString(currentLanguage() || undefined, { weekday: "long", month: "long", day: "numeric" });
  } catch {
    today = now.toDateString();
  }

  return (
    <header className={cn("w-full", props.className, "space-y-1")}>
      <h1 className={cn("text-2xl font-semibold tracking-tight", loading && !designing && "opacity-0")}>
        {__(data.label || greetingFor(now.getHours()))}{name ? `, ${name}` : ""}
      </h1>
      <p className="text-sm text-muted-foreground">
        {[company, today].filter(Boolean).join(" · ")}
      </p>
    </header>
  );
}

DeskGreeting.dontHaveMetaElements = ["name", "text"];

DeskGreeting.metaFields = () => [
  {
    group: "content",
    elements: {
      label: { element: INPUT, data: { label: "Greeting", description: "Empty = by time of day (Good morning…)." } },
    },
  },
];
