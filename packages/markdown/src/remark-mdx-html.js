import { mdxJsx } from 'micromark-extension-mdx-jsx';
import { mdxMd } from 'micromark-extension-mdx-md';
import { mdxJsxFromMarkdown } from 'mdast-util-mdx-jsx';
import { visitParents } from 'unist-util-visit-parents';
import { find, html, svg } from 'property-information';
import { comment, commentFromMarkdown } from './mdast-html-comment.js';

export default function remarkMdxHtml() {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(mdxJsx(), mdxMd(), comment);
  (data.fromMarkdownExtensions ??= []).push(mdxJsxFromMarkdown(), commentFromMarkdown());

  return (tree) => {
    visitParents(tree, (node, ancestors) => {
      if (node.type !== 'mdxJsxFlowElement' && node.type !== 'mdxJsxTextElement') return;

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
