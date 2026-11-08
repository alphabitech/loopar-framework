import React, { useEffect, useState, useRef, useCallback } from "react";
import { Button } from "@cn/components/ui/button";
import { Modal } from "@dialog"
import { Scaner } from "./src/Scaner.jsx";
import loopar from "loopar";
import { GeminiSend, GeminiStatus, GeminiContextProvider } from "../AI/local/Gemini.jsx";
import { AIPrompt, sanitizeAIStructure } from "loopar";
import {useDocument} from "@loopar/document";
import { __ } from "@global/i18n";

export const Prompt = ({
  onSend,
  onClose,
  onComplete,
  getCurrentDesign,
  ...props
}) => {
  const [open, setOpen] = useState(props.open);
  const [sendingPrompt, setSendingPrompt] = useState(props.open);
  const [currentPrompt, setCurrentPrompt] = useState(props.defaultPrompt || "");
  const [AI, setAi] = useState("Remote");
  const [copiedStatus, setCopiedStatus] = useState("waiting");
  const [editCurrent, setEditCurrent] = useState(false);
  const document_type = useDocument().entity;

  // Resolved at send time so the AI always sees the latest structure
  const currentDesign = () => {
    if (!editCurrent || !getCurrentDesign) return null;
    const current = getCurrentDesign();
    return Array.isArray(current) && current.length ? current : null;
  };

  useEffect(() => {
    setOpen(props.open)
  }, [props.open])

  const handleSetPrompt = (value) => {
    setCurrentPrompt(value);
  }

  useEffect(() => {
    setCurrentPrompt(props.defaultPrompt)
  }, [props.defaultPrompt])

  const handelComplete = (response) => {
    setSendingPrompt(false);
    if (response == null) return;
    onComplete && onComplete(response);
  }

  const sendPrompt = (prompt) => {
    setCurrentPrompt(prompt);
    const current = currentDesign();

    loopar.call("AI", "prompt", {
      body: { prompt, document_type, current: current ? JSON.stringify(current) : null },
      success: (message) => {
        if (!loopar.utils.isJSON(message) || !(JSON.parse(message) || []).length) {
          loopar.notify("The AI returned an empty design, your current design was kept. Try rephrasing the request.", "warning");
          return;
        }
        onComplete && onComplete(message);
        onClose && onClose();
      },
      always: () => {
        setSendingPrompt(false);
      },
      freeze: false
    });
  }

  const info = () => {
    if (sendingPrompt) return null
    return (
      <div className="rounded-md border border-gray-100 dark:border-gray-800 p-3 bg-white/60 dark:bg-black/20 transition-all">
        {AI === "Remote" && (
          <div>
            <p className="text-sm text-muted-foreground">
              {__("Works with any OpenAI-compatible provider (OpenAI, Anthropic, Google, Ollama...)")}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
               {__("Navigate to")} <a className="text-blue-500" target="_blanck" href="/desk/integrations">{__("Integrations")}</a>
            </p>
            <ul className="mt-2 ml-4 text-sm list-disc text-muted-foreground">
              <li>{__("Set your API key and Base URL in AI Provider")}</li>
              <li>{__("Create your Models in AI Model")}</li>
              <li>{__("Select the default Model in AI")}</li>
            </ul>
          </div>
        )}
        {AI === "Local" && (
          <div>
            <GeminiStatus />
          </div>
        )}
        {AI === "Browser" && (
          <div>
            <p className="text-sm text-muted-foreground">
              {__("In this mode, you can copy prompt text and paste into your preferred AI service in the browser.")}
            </p>
            <ul className="mt-2 ml-4 text-sm list-disc text-muted-foreground space-y-1">
              <li>
                {__("Click")} <span className="font-semibold border rounded-sm bg-primary/70 p-1 text-secondary">{__("&Copy Prompt")}</span> {__("to prepare your custom prompt.")}
              </li>
              <li>
                {__("Then, paste it into your chosen Chat AI service in the browser:")}
                <a className="text-blue-500 pl-2 pr-2" href="https://chatgpt.com/?model=auto">{__("GPT,")}</a>
                <a className="text-blue-500 pr-2" href="https://gemini.google.com/">{__("Gemini,")}</a>
                <a className="text-blue-500" href="https://grok.com/">{__("Grok")}</a> ...
              </li>
              <li>
                {__("Click")} <span className="font-semibold border rounded-sm bg-primary/70 p-1 text-secondary">{__("&Eval")}</span> {__("to process the response")}
              </li>
            </ul>
          </div>
        )}
      </div>
    )
  };

  return (
    <Modal
      open={open}
      single={true}
      size="lg"
      title={sendingPrompt ? "Waiting for AI response..." : "Design your model with AI"}
      buttons={[]}
      onClose={() => {
        setOpen(false);
        setSendingPrompt(false);
        onClose && onClose();
      }}
    >
      <GeminiContextProvider>
        <div className="flex-grow space-y-4">
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <label className="text-sm font-semibold">{__("AI:")}</label>
              <div className="flex rounded-lg bg-transparent p-1 border border-transparent space-x-2">
                {["Remote", "Local", "Browser"].map((option) => (
                  <button
                    key={option}
                    onClick={() => setAi(option)}
                    disabled={sendingPrompt}
                    aria-pressed={AI === option}
                    className={`px-4 py-1 rounded-md transition-colors text-sm font-medium focus:outline-none focus:ring-1 focus:ring-offset-1
                      ${AI === option
                        ? "bg-destructive text-secondary dark:text-primary shadow-md"
                        : " hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <span className="ml-auto text-xs text-muted-foreground">
                {sendingPrompt ? "Sending…" : "Ready"}
              </span>
            </div>

            {info()}
          </div>

          {sendingPrompt && <Scaner text={currentPrompt} />}

          {!sendingPrompt && getCurrentDesign && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={editCurrent}
                onChange={(e) => setEditCurrent(e.target.checked)}
              />
              {__("Edit current design (the AI receives the current structure and applies your request to it)")}
            </label>
          )}

          {!sendingPrompt && (
            <textarea
              className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 flex field-sizing-content min-h-40 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-lg"
              placeholder={__("Enter your prompt here...")}
              value={currentPrompt}
              onChange={(e) => {
                handleSetPrompt(e.target.value);
              }}
            />
          )}
          <div className="flex flex-row pt-4">
            <div className="flex flex-row justify-end w-full">
              <div className="mt-4 text-right space-x-2">
                {sendingPrompt && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSendingPrompt(false);
                    }}
                  >
                    {__("Rewrite")}
                  </Button>
                )}

                {!sendingPrompt && (
                  <>
                    {AI === "Remote" && (
                      <Button
                        variant="primary"
                        onClick={() => {
                          setSendingPrompt(true);
                          sendPrompt(currentPrompt);
                        }}
                      >
                        {__("Send")}
                      </Button>
                    )}
                    {AI === "Local" && (
                      <GeminiSend
                        inputText={currentPrompt}
                        getCurrentDesign={currentDesign}
                        isUserActivated={AI === "Local"}
                        onStart={() => setSendingPrompt(true)}
                        onComplete={handelComplete}
                        onError={() => setSendingPrompt(false)}
                      />
                    )}
                    {AI === "Browser" && (
                      <Button
                        variant="primary"
                        onClick={async () => {
                          if (copiedStatus === "waiting") {
                            const promp = AIPrompt(currentPrompt, document_type, currentDesign());
                            navigator.clipboard.writeText(promp.system.content + "\n" + promp.user.content + "\n" + "Respond in a plain JSON code block (```json ...```)");
                            setCopiedStatus("copied");
                            loopar.notify("Prompt copied to clipboard", "success");
                          } else if (copiedStatus === "copied") {
                            const r = sanitizeAIStructure(loopar.utils.evaluateAIResponse(await navigator.clipboard.readText(), "[", "]"));
                            if (!r.length) {
                              loopar.notify("Could not read a design from the clipboard, your current design was kept.", "warning");
                              return;
                            }
                            onComplete && onComplete(r);
                            setSendingPrompt(false);
                            onClose && onClose();
                            setCopiedStatus("waiting");
                          }
                        }}
                      >
                        {copiedStatus === "waiting" && "&Copy Prompt"}
                        {copiedStatus === "copied" && "&Eval"}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </GeminiContextProvider>
    </Modal>
  );
}