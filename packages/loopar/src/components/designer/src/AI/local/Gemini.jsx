import React, { useEffect, useState, useRef, createContext, useContext } from "react";
import {Button} from "@cn/components/ui/button";
import {useDocument} from "@loopar/document";

import { AIPrompt, AIStructureSchema, sanitizeAIStructure, loopar } from "loopar";
import { __ } from "@global/i18n";

const GeminiContext = createContext({
  status: "checking"
})

export const GeminiContextProvider = ({children}) => {
  const [status, setStatus] = useState("checking");
  const [downloadprogress, setDownloadprogress] = useState(0);

  useEffect(() => {
    let mounted = true;
    async function check() {
      setStatus("checking");
      try {
        if (!window.LanguageModel || !window.LanguageModel.availability) {
          setStatus("unavailable");
          return;
        }
        const a = await window.LanguageModel.availability();
        if (!mounted) return;
        setStatus(a); // "downloadable", "available", "downloading", "unavailable"
      } catch (err) {
        console.error("availability error", err);
        setStatus("error");
      }
    }
    check();

    return () => (mounted = false);
  }, []);

  const install = async () =>{
    if (navigator.userActivation.isActive) {
      if(window.LanguageModel && window.LanguageModel.create){
        await LanguageModel.create({
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              setDownloadprogress(e.loaded * 100);
              setStatus("downloading");
              console.log(`Downloaded ${e.loaded * 100}%`);
            });
          },
        });

        setStatus("available");
      } else {
        setStatus("unavailable")
        loopar.throw("Gemini Nano is not available in this browser")
      }
    }
  }

  return (
    <GeminiContext.Provider value = {{
      status,
      install,
      downloadprogress
    }}
    >
      {children}
    </GeminiContext.Provider>
  )
}

export const useGeminiContext = () => useContext(GeminiContext)

export function GeminiSend({inputText, getCurrentDesign, isUserActivated, onStart, onComplete, onError}) {
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const {status} = useGeminiContext();
  const documentType = useDocument().entity;

  const doPrompt = async () => {
    onStart && onStart();
    try {
      if(navigator.userActivation.isActive) {
        setSendingPrompt(true);
        const prompt = AIPrompt(inputText, documentType, getCurrentDesign ? getCurrentDesign() : null);
        const format = AIStructureSchema(documentType);

        const modelParams = LanguageModel.params ? await LanguageModel.params() : null;
        const session = await LanguageModel.create({
          temperature: modelParams?.defaultTemperature ?? 0.7,
          topK: modelParams?.defaultTopK ?? 3,
          initialPrompts: [
            {
              role: "system",
              content: prompt.system.content
            }
          ],
        });

        let r;
        try {
          r = await session.prompt(prompt.user.content, { responseConstraint: format.schema });
        } catch (err) {
          // responseConstraint unsupported on this Chrome/model -> unconstrained retry
          console.warn("responseConstraint failed, retrying unconstrained", err);
          r = await session.prompt(prompt.user.content);
        }

        let parsed;
        try {
          const obj = JSON.parse(r);
          parsed = sanitizeAIStructure(Array.isArray(obj) ? obj : obj.elements || []);
        } catch {
          parsed = sanitizeAIStructure(loopar.utils.evaluateAIResponse(r, "[", "]"));
        }

        // Empty result: NEVER hand it to onComplete — that would wipe the design
        if (parsed.length) {
          onComplete && onComplete(parsed);
        } else {
          onError && onError();
          loopar.notify("The AI returned an empty design, your current design was kept. Try rephrasing the request.", "warning");
        }
      }else{
        loopar.throw("Please interact with the page (click, tap, etc.) before using the AI features.");
      }
    } catch (err) {
      console.error("LLM error", err);
      onError && onError(err);
      loopar.throw(err.message || err.toString());
    } finally {
      setSendingPrompt(false);
    }
  };

  return (
    <Button onClick={doPrompt} disabled={status !== "available" || !isUserActivated || sendingPrompt}>
      {sendingPrompt ? <div className="loader mr-2"/> : null}
      {__("Send")}
    </Button>
  );
}

export function GeminiStatus(){
  const {status, install, downloadprogress} = useGeminiContext();

  if(status === "unavailable") {
    return (
      <div className="text-sm text-red-500">
        {__("Gemini Nano is not available in this browser")}
        <br/>
        <a className="text-blue-500" href="https://developer.chrome.com/docs/ai/built-in-apis" target="_blank" rel="noopener noreferrer">{__("Please see documentation for supported browsers")}</a>
      </div>
    );
  }

  return (
    <div className="mb-4 flex flex-row items-center space-x-2">
      {status === "checking" ? (
        <div className="loader mr-2"/>
      ) : null}
      {status === "available" ? (
        <div className="text-sm text-success">
          <p>
            {__("Gemini Nano is available and ready to use.")}
          </p>
          <ul className="mt-2 ml-4 text-sm list-disc text-muted-foreground">
            <li>
              <a href="https://developer.chrome.com/docs/ai/prompt-api" target="_blank" rel="noopener noreferrer" className="text-sm text-blue-500">
                {__("Learn more about Gemini Nano")}
              </a>
            </li>
            <li>{__("This model works offline and does not require an internet connection.")}</li>
          </ul>
        </div>
      ) : null}
      {status === "downloadable" ? (
        <Button onClick={install}>{__("Install Gemini Nano")}</Button>
      ) : null}
      {status === "downloading" ? (
        <div className="text-sm text-primary">
          {__("Downloading Gemini Nano...")} {downloadprogress.toFixed(2)}%
        </div>
      ) : null}
      {status === "error" ? (
        <div className="text-sm text-destructive">
          {__("Error checking Gemini Nano availability. Please try again later.")}
        </div>
      ) : null}
    </div>
  );
}