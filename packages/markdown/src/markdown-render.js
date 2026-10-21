import React from 'react';
import MarkdownPreview from '@uiw/react-markdown-preview';
import { renderToString } from "react-dom/server";
import remarkMdxHtml from './remark-mdx-html.js';

const remarkPlugins = [remarkMdxHtml];

export function renderMarkdown(markdown) {
  if (!markdown || markdown.trim() === '') return '';

  const source = markdown.replace(/\r\n/g, '\n');

  try {
    return renderToString(
      React.createElement(MarkdownPreview, { source, remarkPlugins })
    );
  } catch (error) {
    console.error('[markdown] parse error:', error.message);
    return renderToString(
      React.createElement('div', { className: 'wmde-markdown wmde-markdown-color' },
        React.createElement('pre', { style: { whiteSpace: 'pre-wrap' } }, source)
      )
    );
  }
}
