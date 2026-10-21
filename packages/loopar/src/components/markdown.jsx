import { 
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  linkPlugin,
  linkDialogPlugin,
  imagePlugin,
  tablePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  frontmatterPlugin,
  directivesPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  CodeToggle,
  BlockTypeSelect,
  CreateLink,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  Separator,
  InsertCodeBlock,
  ChangeCodeMirrorLanguage,
  ConditionalContents,
  AdmonitionDirectiveDescriptor,
  viewMode$,
  usePublisher,
} from '@mdxeditor/editor';

import { ComponentDefaults } from "./base/ComponentDefaults";
import '@mdxeditor/editor/style.css';
import './markdown/mdx-theme.css';
import { useCallback, useState, useEffect } from 'react';
import { Preview } from './markdown/preview.jsx';
import { useDesigner } from "@context/designer-context";
import { cn } from "@cn/lib/utils";

const directiveLabel = (node) =>
  (node.children || [])
    .map((child) => child.value ?? directiveLabel(child))
    .join('');

const LiteralTextDirectiveDescriptor = {
  name: 'literal-text-directive',
  type: 'textDirective',
  testNode: (node) => node.type === 'textDirective',
  attributes: [],
  hasChildren: false,
  Editor: ({ mdastNode }) => {
    const label = directiveLabel(mdastNode);
    return <span>:{mdastNode.name}{label ? `[${label}]` : ''}</span>;
  },
};

const codeBlockLanguages = {
  js: 'JavaScript',
  jsx: 'JavaScript (React)',
  ts: 'TypeScript',
  tsx: 'TypeScript (React)',
  css: 'CSS',
  html: 'HTML',
  json: 'JSON',
  md: 'Markdown',
  sql: 'SQL',
  bash: 'Bash',
  python: 'Python',
  '': 'Plain Text',
};

const VIEW_MODES = {
  EDITOR_SOURCE: [
    { id: 'rich-text', label: 'Editor', icon: '✏️' },
    { id: 'source', label: 'Markdown', icon: '📝' },
  ],
  EDITOR_SOURCE_DIFF: [
    { id: 'rich-text', label: 'Editor', icon: '✏️' },
    { id: 'source', label: 'Markdown', icon: '📝' },
    { id: 'diff', label: 'Diff', icon: '🔄' },
  ],
  EDITOR_ONLY: [
    { id: 'rich-text', label: 'Editor', icon: '✏️' },
  ],
};

export { Preview };

function EditorTabs({ 
  currentMode, 
  onModeChange, 
  modes = VIEW_MODES.EDITOR_SOURCE,
  showIcons = true,
  showLabels = true,
  className = '',
}) {
  return (
    <div className={`
      flex gap-0 border-b border-border bg-card 
      rounded-t-md px-2
      ${className}
    `}>
      {modes.map(({ id, label, icon }) => {
        const isActive = currentMode === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onModeChange(id)}
            className={`
              relative flex items-center gap-1.5 
              px-4 py-3 text-sm font-medium
              border-none bg-transparent cursor-pointer
              transition-all duration-150
              ${isActive 
                ? 'text-primary' 
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }
            `}
          >
            {showIcons && <span className="text-sm">{icon}</span>}
            {showLabels && <span className="text-[13px] hidden sm:inline">{label}</span>}
            
            {/* Active indicator */}
            {isActive && (
              <span className="absolute bottom-[-1px] left-0 right-0 h-0.5 bg-primary rounded-t-sm" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function ToolbarContents() {
  return (
    <>
      <UndoRedo />
      <Separator />
      
      <BoldItalicUnderlineToggles />
      <CodeToggle />
      <Separator />
      
      <BlockTypeSelect />
      <Separator />
      
      <ListsToggle />
      <Separator />
      
      <CreateLink />
      <InsertImage />
      <Separator />
      
      <InsertTable />
      <InsertThematicBreak />
      <Separator />
      
      <ConditionalContents
        options={[
          {
            when: (editor) => editor?.editorType === 'codeblock',
            contents: () => <ChangeCodeMirrorLanguage />,
          },
          {
            fallback: () => <InsertCodeBlock />,
          },
        ]}
      />
    </>
  );
}

function ViewModeSync({ externalMode }) {
  const setInternalMode = usePublisher(viewMode$);

  useEffect(() => {
    setInternalMode(externalMode);
  }, [externalMode, setInternalMode]);

  return null;
}

export default function MDXEditorWithTabs(props) {
  const { set, data } = ComponentDefaults(props);
  const { designing, designerMode } = useDesigner();
  const [isMounted, setIsMounted] = useState(false);
  
  const {
    placeholder = 'Start writing...',
    className="dark-theme dark-editor" ,
    readOnly = false,
    showDiff = false,
    tabPosition = 'top',
    showTabIcons = true,
    showTabLabels = true,
  } = props;

  const initialMarkdown = data.value || '';
  const key = `mdx_viewmode_${props.node}`;
  
  const [currentMode, setCurrentMode] = useState('rich-text');

  useEffect(() => {
    setCurrentMode(localStorage.getItem(key) || 'rich-text')
    setIsMounted(true);
  }, [])

  const handleChange = useCallback((value) => {
    set("value", value);
    setTimeout(() => {
      props.onChange && props.onChange(value);
    })
  }, [set]);

  const handleModeChange = (mode) => {
    (isMounted && typeof localStorage != undefined) && localStorage.setItem(key, mode)
    setCurrentMode(mode);
  };

  const availableModes = showDiff 
    ? VIEW_MODES.EDITOR_SOURCE_DIFF 
    : VIEW_MODES.EDITOR_SOURCE;

  const TabsComponent = (
    <EditorTabs
      currentMode={currentMode}
      onModeChange={handleModeChange}
      modes={availableModes}
      showIcons={showTabIcons}
      showLabels={showTabLabels}
    />
  );

  if(!isMounted || (designerMode && !designing)) return (
    <Preview source={initialMarkdown}/>
  )

  return (
    <div className={cn(
      'no-drag',
      designerMode && 'overflow-x-auto'
    )}>
      <div className={cn(
        "mdx-editor-container",
        designerMode && "min-w-[400px]"
      )}>
        {TabsComponent}
        <div className="mdx-editor-wrapper">
          <MDXEditor
            key={`${key}_${currentMode}`}
            markdown={initialMarkdown}
            onChange={handleChange}
            readOnly={readOnly}
            placeholder={placeholder}
            className={className}
            plugins={[
              headingsPlugin(),
              listsPlugin(),
              quotePlugin(),
              thematicBreakPlugin(),
              linkPlugin(),
              linkDialogPlugin(),
              tablePlugin(),
              
              imagePlugin({
                imageUploadHandler: async (file) => {
                  return URL.createObjectURL(file);
                },
              }),
              
              codeBlockPlugin({ defaultCodeBlockLanguage: 'js' }),
              codeMirrorPlugin({ 
                codeBlockLanguages,
                autoLoadLanguageSupport: true,
              }),
              
              diffSourcePlugin({ 
                viewMode: currentMode,
              }),
              
              frontmatterPlugin(),
              
              directivesPlugin({
                directiveDescriptors: [AdmonitionDirectiveDescriptor, LiteralTextDirectiveDescriptor],
              }),
              
              markdownShortcutPlugin(),
              
              toolbarPlugin({
                toolbarContents: () => (
                  <>
                    <ToolbarContents />
                    <ViewModeSync externalMode={currentMode} />
                  </>
                ),
              }),
            ]}
          />
        </div>
      </div>
    </div>
  );
}


export { 
  EditorTabs,
  ToolbarContents,
  VIEW_MODES,
  viewMode$, 
  usePublisher,
};