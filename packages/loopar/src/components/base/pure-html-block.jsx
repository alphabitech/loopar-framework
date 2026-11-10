import { cn } from "@cn/lib/utils";
import { useEffect, memo } from 'react';

export const Markdown = memo(({ className, content }) => {
  const markup = { __html: content };

  useEffect(() => {
    const handleCopyClick = async (event) => {
      const copyButton = event.target.closest("[data-code]");
      if (copyButton) {
        const code = copyButton.getAttribute("data-code");
        try {
          await navigator.clipboard.writeText(code);
          copyButton.classList.add("active");
          setTimeout(() => copyButton.classList.remove("active"), 2000);
        } catch (err) {
          console.error("❌ Error on copy code:", err);
          copyButton.classList.remove("active");
        }
      }
    };

    document.addEventListener("click", handleCopyClick);
    return () => document.removeEventListener("click", handleCopyClick);
  }, []);

  return (
    <div
      className={cn(className, "lp-markdown")}
      dangerouslySetInnerHTML={markup}
    />
  );
});

export default function PureHTMLBlock({ element, className = "", data, ...props }) {
  return (
    <div
      className="contents w-full prose dark:prose-invert"
      {...props}
    >
      <div className={cn(className)} id={data.id}>
        <Markdown content={data.value} />
      </div>
    </div>
  );
}
