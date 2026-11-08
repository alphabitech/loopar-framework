import { useState, useCallback, useRef, useEffect } from "react";
import { ComponentDefaults } from "./base/ComponentDefaults";
import { Code, Copy, Check } from "lucide-react";
import loopar from "loopar";
import { useDesigner, DesignerContext } from "@context/designer-context";
import { FormWrapper } from "@form-provider";

import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { keymap } from '@codemirror/view';
import { Highlight, themes } from 'prism-react-renderer';
import MetaComponent from "@meta-component";
import { __ } from "@global/i18n";

function CodeMirrorEditor({ value, onChange }) {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const isInternalUpdate = useRef(false);

  useEffect(() => {
    if (!editorRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !isInternalUpdate.current) {
        const newValue = update.state.doc.toString();
        onChange?.(newValue);
      }
    });

    const state = EditorState.create({
      doc: value || "",
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        foldGutter(),
        bracketMatching(),
        closeBrackets(),
        json(),
        //oneDark,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...closeBracketsKeymap,
          ...foldKeymap,
        ]),
        updateListener,
        EditorView.lineWrapping,
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "13px",
          },
          ".cm-scroller": {
            overflow: "auto",
            fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace",
          },
          ".cm-content": {
            padding: "16px 0",
          },
          ".cm-line": {
            padding: "0 16px",
          },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
    };
  }, []);

  useEffect(() => {
    if (viewRef.current) {
      const currentValue = viewRef.current.state.doc.toString();
      if (value !== currentValue) {
        isInternalUpdate.current = true;
        viewRef.current.dispatch({
          changes: {
            from: 0,
            to: currentValue.length,
            insert: value || "",
          },
        });
        isInternalUpdate.current = false;
      }
    }
  }, [value]);

  return (
    <div 
      ref={editorRef} 
      className="h-full w-full overflow-hidden"
    />
  );
}

function CodePreview({ code }) {
  return (
    <Highlight theme={themes.vsDark} code={code || ""} language="json">
      {({ style, tokens, getLineProps, getTokenProps }) => (
        <pre 
          className="h-full p-4 overflow-auto text-sm font-mono m-0"
          style={{ ...style, background: 'transparent' }}
        >
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })} className="table-row">
              <span className="table-cell text-muted-foreground pr-4 select-none text-right w-8 opacity-50">
                {i + 1}
              </span>
              <span className="table-cell whitespace-pre">
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </span>
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

export default function ExampleViewer(props) {
  const { set, data } = ComponentDefaults(props);
  const [copied, setCopied] = useState(false);
  const [liveValue, setLiveValue] = useState(data.value || "");
  const { designing } = useDesigner();
  const debounceRef = useRef(null);

  useEffect(() => {
    setLiveValue(data.value || "");
  }, [data.value]);

  const formatJSON = useCallback((jsonString) => {
    try {
      const parsed = loopar.utils.JSONparse(jsonString, null);
      if (parsed) {
        return JSON.stringify(parsed, null, 2);
      }
    } catch (e) {}
    return jsonString || "";
  }, []);

  const formattedValue = formatJSON(liveValue);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(formattedValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleChange = useCallback((value) => {
    setLiveValue(value);
    
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      if (data.value !== value) {
        set("value", value);
      }
    }, 500);
  }, [set, data.value]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const previewElements = loopar.utils.JSONparse(
    data.original_value || liveValue, 
    []
  );

  return (
    <div className="border rounded-lg overflow-hidden bg-card my-6">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/50">
        <div className="flex items-center gap-4">
          {data.title ? (
            <h3 className="font-semibold text-sm">{data.title}</h3>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Code className="w-4 h-4" />
              <span>{__("Model JSON")}</span>
            </div>
          )}
        </div>
        
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-muted"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-green-500" />
              <span className="text-green-500">{__("Copied!")}</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>{__("Copy")}</span>
            </>
          )}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 h-[500px]">
        <div className="border-b lg:border-b-0 lg:border-r overflow-hidden bg-muted/40">
          {designing ? (
            <CodeMirrorEditor 
              value={formattedValue}
              onChange={handleChange}
              className="bg-red-500"
            />
          ) : (
            <CodePreview code={formattedValue} />
          )}
        </div>

        <div className="overflow-y-auto p-4 bg-background">
          <DesignerContext.Provider value={{designerMode: false}}>
            <FormWrapper __DATA__={{}} className="w-full" formRef={null}>
              <MetaComponent elements={previewElements} />
            </FormWrapper>
          </DesignerContext.Provider>
        </div>
      </div>

      {data.description && (
        <div className="px-4 py-3 border-t bg-muted/30">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {data.description}
          </p>
        </div>
      )}
    </div>
  );
}

ExampleViewer.dontHaveMetaElements = ["label", "text"];

ExampleViewer.metaFields = () => {
  return [
    [
      {
        group: "form",
        elements: {
          title: { element: INPUT },
          description: { element: TEXTAREA },
        }
      }
    ]
  ];
};