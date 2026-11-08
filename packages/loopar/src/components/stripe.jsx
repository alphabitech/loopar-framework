import { useEffect, useRef, useState } from "react";
import loopar from "loopar";
import { Modal } from "@dialog";
import { __ } from "@global/i18n";

const STRIPE_JS = "https://js.stripe.com/v3/";

const cardStyle = (dark) => ({
  base: {
    color: dark ? "#fff" : "#000",
    iconColor: dark ? "#fff" : "#000",
    lineHeight: "40px",
    fontWeight: 300,
    fontFamily: '"Helvetica Neue", Helvetica, sans-serif',
    fontSize: "15px",
    "::placeholder": { color: dark ? "" : "#42425da9" },
  },
});

/**
 * Card payment button + modal. Mounts a Stripe card element when the modal
 * opens and confirms the payment against `Stripe/clientSecret`.
 * Needs `publishable_key`; `label` names the button, `amount_label` the pay button.
 */
export default function Stripe({ data = {}, designer, buttonClassName, onClose }) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef(null);
  const nameRef = useRef(null);
  const stripeRef = useRef({ stripe: null, card: null });

  // Mount the card element while the modal is open.
  useEffect(() => {
    if (!open || designer || !data.publishable_key) return;
    let disposed = false;

    loopar.require(STRIPE_JS).then(() => {
      if (disposed || !cardRef.current || !window.Stripe) return;
      const stripe = window.Stripe(data.publishable_key);
      const card = stripe.elements().create("card", {
        hidePostalCode: true,
        style: cardStyle(localStorage.getItem("skin") === "dark"),
      });
      card.mount(cardRef.current);
      stripeRef.current = { stripe, card };
    });

    return () => {
      disposed = true;
      stripeRef.current.card?.destroy();
      stripeRef.current = { stripe: null, card: null };
    };
  }, [open, designer, data.publishable_key]);

  const pay = async (e) => {
    e.preventDefault();
    const { stripe, card } = stripeRef.current;
    if (!stripe || !card) return;

    const { message: intent } = await loopar.call("Stripe", "clientSecret");
    const { error } = await stripe.confirmCardPayment(intent.client_secret, {
      payment_method: { card, billing_details: { name: nameRef.current?.value } },
    });

    if (error) {
      loopar.dialog({ title: "Error", type: "error", content: error.message });
      return;
    }
    loopar.dialog({ title: "Success", type: "success", content: "Payment success" });
    setOpen(false);
  };

  return (
    <>
      <button
        className={buttonClassName || "btn btn-primary btn-block"}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
      >
        <span className="fas fa-lock mr-2" />
        <span>{data.label}</span>
      </button>

      <Modal
        size="md"
        id="payment_modal"
        title={data.label || "Payment"}
        icon="fa fa-lock"
        open={open}
        hasFooter={false}
        buttons={[]}
        onClose={() => { setOpen(false); onClose?.(); }}
      >
        <small className="text-muted">
          {__("Your payment is secure with us. We've partnered with Stripe, a trusted and industry-leading payment platform.")}
        </small>
        <form className="card-form" onSubmit={pay}>
          <div className="card-body">
            <div className="form-group">
              <input ref={nameRef} className="form-control" name="name" type="text" placeholder={__("Name on card")} aria-label={__("Name on card")} />
            </div>
            <div className="form-group">
              <div className="form-control" style={{ height: 55 }}>
                <div ref={cardRef} aria-label={__("Credit or debit card")} />
              </div>
            </div>
            <div className="form-group">
              <button className="btn btn-primary btn-block" type="submit">
                <span className="fas fa-lock mr-2" />
                <span>{data.amount_label || "Pay"}</span>
              </button>
            </div>
            <div className="col-12 text-center">
              <span className="fab fa-stripe fa-5x" />
            </div>
          </div>
        </form>
      </Modal>
    </>
  );
}

Stripe.metaFields = () => [
  {
    group: "custom",
    elements: {
      publishable_key: { element: INPUT },
      amount_label: { element: INPUT },
    },
  },
];
