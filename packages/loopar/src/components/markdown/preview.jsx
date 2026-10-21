import MarkdownPreview from '@uiw/react-markdown-preview';
import remarkMdxHtml from 'markdown/remark-mdx-html';
import { ErrorBoundary } from 'react-error-boundary';

/**
 * Read-only markdown rendering. Kept apart from markdown.jsx on purpose:
 * that module pulls in the whole MDX editor (+ CodeMirror, Lexical, CSS),
 * which must never ride along with code that only needs to DISPLAY markdown
 * (read-only fields, print, collection detail pages).
 *
 */
const remarkPlugins = [remarkMdxHtml];

const ParseError = ({ error, source }) => (
  <div className="wmde-markdown wmde-markdown-color">
    <p className="text-destructive text-sm">Markdown error: {error.message}</p>
    <pre style={{ whiteSpace: 'pre-wrap' }}>{source}</pre>
  </div>
);

export function Preview({ source }) {
  return (
    <div className="lp-markdown p-2">
      <ErrorBoundary
        resetKeys={[source]}
        fallbackRender={({ error }) => <ParseError error={error} source={source} />}
      >
        <MarkdownPreview source={source} remarkPlugins={remarkPlugins} />
      </ErrorBoundary>
    </div>
  );
}

export default Preview;
