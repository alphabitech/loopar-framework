import { mdxJsx } from 'micromark-extension-mdx-jsx';
import { mdxMd } from 'micromark-extension-mdx-md';
import { mdxJsxFromMarkdown } from 'mdast-util-mdx-jsx';
import { visitParents, SKIP } from 'unist-util-visit-parents';
import { find, html, svg } from 'property-information';
import { comment, commentFromMarkdown } from './mdast-html-comment.js';

const OPAQUE = new Set(['svg', 'style', 'script', 'math']);

export default function remarkMdxHtml() {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(mdxJsx(), mdxMd(), comment);
  (data.fromMarkdownExtensions ??= []).push(mdxJsxFromMarkdown(), commentFromMarkdown());

  return (tree, file) => {
    const source = String(file?.value ?? '');

    visitParents(tree, (node, ancestors) => {
      if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') return;

      // Opaque elements: their content is NOT markdown (SVG geometry, CSS, JS).
      // Parsed as markdown, every SVG <text> would get wrapped in a <p> and the
      // browser would break the drawing; CSS could be read as lists/quotes.
      // They are emitted verbatim as raw HTML and rehype-raw parses them.
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (OPAQUE.has(node.name) && source && start != null && end != null) {
        const parent = ancestors[ancestors.length - 1];
        const html = { type: 'html', value: source.slice(start, end), position: node.position };
        parent.children[parent.children.indexOf(node)] = html;
        return SKIP;
      }

      const inSvg = node.name === 'svg' || ancestors.some((a) => a.name === 'svg');
      const schema = inSvg ? svg : html;

      const hProperties = {};
      for (const attr of node.attributes || []) {
        if (attr.type !== 'mdxJsxAttribute') continue;
        if (attr.value && typeof attr.value === 'object') continue;
        hProperties[find(schema, attr.name).property] = attr.value ?? true;
      }

      node.data = {
        ...node.data,
        hName: node.name || (node.type === 'mdxJsxFlowElement' ? 'div' : 'span'),
        hProperties,
      };
    });
  };
}
