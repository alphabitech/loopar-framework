import { DecoratorNode } from 'lexical';
import {
  realmPlugin,
  htmlTags,
  addImportVisitor$,
  addLexicalNode$,
  addExportVisitor$,
} from '@mdxeditor/editor';
import { toMarkdown } from 'mdast-util-to-markdown';
import { mdxJsxToMarkdown } from 'mdast-util-mdx-jsx';

/**
 * MDXEditor can only edit the HTML tags in its `htmlTags` list; an <svg> (or
 * any tag outside it) breaks rich-text mode with "Parsing of the following
 * markdown structure failed". <style>/<script> are in the list, but their
 * content is not markdown: editing them as paragraphs can alter the CSS on save.
 *
 * This plugin treats them as OPAQUE blocks: rich-text mode shows a read-only
 * preview (they are edited in Source mode) and export returns the original
 * mdast node untouched. Same rule as remark-mdx-html (renderer).
 */
const OPAQUE = new Set(['svg', 'style', 'script', 'math']);

const isOpaque = (node) =>
  (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') &&
  !!node.name &&
  (OPAQUE.has(node.name) || !htmlTags.includes(node.name.toLowerCase()));

const toSource = (mdastNode) => {
  try {
    return toMarkdown(mdastNode, { extensions: [mdxJsxToMarkdown()] });
  } catch {
    return '';
  }
};

function RawHtmlPreview({ mdastNode }) {
  const name = mdastNode.name;
  const showPreview = name !== 'script' && name !== 'style';

  return (
    <div className="my-2 rounded-md border border-dashed border-muted-foreground/40 p-2" contentEditable={false}>
      <div className="mb-1 text-xs text-muted-foreground">
        &lt;{name}&gt; · edit in Source mode
      </div>
      {showPreview && (
        <div
          className="pointer-events-none"
          dangerouslySetInnerHTML={{ __html: toSource(mdastNode) }}
        />
      )}
    </div>
  );
}

export class RawHtmlNode extends DecoratorNode {
  __mdastNode;

  static getType() {
    return 'loopar-raw-html';
  }

  static clone(node) {
    return new RawHtmlNode(structuredClone(node.__mdastNode), node.__key);
  }

  static importJSON(serialized) {
    return new RawHtmlNode(serialized.mdastNode);
  }

  constructor(mdastNode, key) {
    super(key);
    this.__mdastNode = mdastNode;
  }

  exportJSON() {
    return { type: 'loopar-raw-html', version: 1, mdastNode: this.__mdastNode };
  }

  getMdastNode() {
    return this.__mdastNode;
  }

  createDOM() {
    return document.createElement(this.isInline() ? 'span' : 'div');
  }

  updateDOM() {
    return false;
  }

  isInline() {
    return this.__mdastNode.type === 'mdxJsxTextElement';
  }

  decorate() {
    return <RawHtmlPreview mdastNode={this.__mdastNode} />;
  }
}

const $isRawHtmlNode = (node) => node instanceof RawHtmlNode;

const MdastRawHtmlVisitor = {
  testNode: isOpaque,
  visitNode({ lexicalParent, mdastNode }) {
    lexicalParent.append(new RawHtmlNode(mdastNode));
  },
  // Runs before the core HTML visitor (-100) so it also catches <style>/<script>.
  priority: 100,
};

const LexicalRawHtmlVisitor = {
  testLexicalNode: $isRawHtmlNode,
  visitLexicalNode({ actions, mdastParent, lexicalNode }) {
    actions.appendToParent(mdastParent, lexicalNode.getMdastNode());
  },
};

export const rawHtmlPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addImportVisitor$]: MdastRawHtmlVisitor,
      [addLexicalNode$]: RawHtmlNode,
      [addExportVisitor$]: LexicalRawHtmlVisitor,
    });
  },
});
