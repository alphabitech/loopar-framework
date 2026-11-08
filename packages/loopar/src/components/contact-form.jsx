import { useState, useEffect, useRef } from 'react';
import { Button } from '@cn/components/ui/button';
import { cn } from '@cn/lib/utils';
import loopar from "loopar";
import { useCaptcha, CaptchaSlot } from './captcha-widget';
import { Entity } from "../loader.jsx";
import { useDocument } from "@loopar/document";
import { useDesigner } from "@context/designer-context";
import { SendHorizonalIcon } from "lucide-react";
import { __ } from "@global/i18n";

export const SendButton = ({ captcha, getBotFields, onSent, onError, children }) => {
  const { docRef } = useDocument();
  const { designerMode } = useDesigner();
  const [sending, setSending] = useState(false);

  if (!docRef?.Form || !docRef.save || designerMode) return null;

  const send = async (e) => {
    e.preventDefault();

    if (sending || !captcha.ready) return;

    const valid = await docRef.Form.trigger();
    if (!valid) return;

    setSending(true);
    onError?.(null);

    const done = () => {
      setSending(false);
      captcha.reset();
    };

    try {
      const request = docRef.save({
        extra: getBotFields(),
        success: (r) => {
          done();
          onSent?.(r?.message);
        },
        error: (err) => {
          done();
          onError?.(err?.message || "Something went wrong. Please try again.");
        }
      });

      if (request === undefined) done();
    } catch (err) {
      done();
    }
  };

  return (
    <Button
      variant="secondary"
      tabIndex="0"
      onClick={send}
      disabled={sending || !captcha.ready}
      className="flex allign-items-right"
    >
      <SendHorizonalIcon className="pr-1" />
      {sending ? "Sending..." : children}
    </Button>
  );
};

export default function ContactForm(props) {
  const data = props.data;
  const {
    success_message = "Message sent successfully!",
    button_text = "Send Message",
    show_reset_button = 1,
    reset_button_text = "Send another message"
  } = data;

  const [sent, setSent] = useState(false);
  const [sentMessage, setSentMessage] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [formKey, setFormKey] = useState(0);

  const captcha = useCaptcha();
  const [hp, setHp] = useState("");
  const mountTsRef = useRef(null);
  useEffect(() => { mountTsRef.current = Date.now(); }, [formKey]);

  const getBotFields = () => ({
    captcha_token: captcha.token,
    _hp: hp,
    _elapsed: Date.now() - (mountTsRef.current || Date.now()),
    source_page: typeof window !== "undefined" ? window.location.pathname : ""
  });

  const handleSent = (message) => {
    setSentMessage(message || success_message);
    setSent(true);
  };

  const handleWriteAnother = () => {
    setSent(false);
    setSentMessage(null);
    setErrorMessage(null);
    setHp("");
    setFormKey((k) => k + 1); // fresh, clean form
    captcha.reset();
  };

  if (!data.entity) {
    return <h1>{__("No Contact Form set")}</h1>;
  }

  if (sent) {
    return (
      <div className="text-center p-8">
        <div className="text-4xl mb-4">✉️</div>
        <h3 className="text-2xl font-bold mb-6">{String(sentMessage || success_message)}</h3>
        {[1, "1", true, "true"].includes(show_reset_button) && (
          <Button variant="outline" onClick={handleWriteAnother}>
            {reset_button_text}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <Entity key={formKey} name={data.entity} action="create" hasSubmiting>
        {/* Honeypot — invisible to humans, bait for bots */}
        <div
          aria-hidden="true"
          style={{ position: "absolute", left: "-9999px", top: "auto", width: "1px", height: "1px", overflow: "hidden" }}
        >
          <label htmlFor={`cf_hp_${formKey}`}>{__("Website")}</label>
          <input
            id={`cf_hp_${formKey}`}
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={hp}
            onChange={(e) => setHp(e.target.value)}
          />
        </div>

        <CaptchaSlot captcha={captcha} />

        {errorMessage && (
          <p className="text-sm text-destructive py-2">{String(errorMessage)}</p>
        )}

        <SendButton
          captcha={captcha}
          getBotFields={getBotFields}
          onSent={handleSent}
          onError={setErrorMessage}
        >
          {button_text}
        </SendButton>
      </Entity>
    </div>
  );
}

ContactForm.metaFields = () => {
  return [[
    {
      group: "General",
      elements: {
        entity: {
          element: SELECT,
          data: {
            label: "Entity",
            description: "Entity to use",
            options: "Contact Form Builder"
          }
        }
      }
    },
    {
      group: "content",
      elements: {
        label: {
          element: INPUT,
          data: {
            label: "Title",
            description: "Form title displayed above the fields",
            default: "Contact Us"
          }
        },
        success_message: {
          element: INPUT,
          data: {
            label: "Success Message",
            description: "Message shown after successful submission",
            default: "Message sent successfully!"
          }
        },
        button_text: {
          element: INPUT,
          data: {
            label: "Button Text",
            default: "Send Message"
          }
        },
        show_reset_button: {
          element: SWITCH,
          data: {
            label: "Show Reset Button",
            description: "Show button to send another message after success",
            default: 1
          }
        },
        reset_button_text: {
          element: INPUT,
          data: {
            label: "Reset Button Text",
            default: "Send another message"
          }
        }
      }
    }
  ]];
};
