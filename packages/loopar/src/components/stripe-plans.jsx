import { useState, useEffect, useMemo } from "react";
import { Input } from "@cn/components/ui/input";
import { Button } from "@cn/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@cn/components/ui/dialog";
import { cn } from "@cn/lib/utils";
import { Loader2 } from "lucide-react";
import loopar from "loopar";
import { __ } from "@global/i18n";

/**
 * <stripe-plans> — Loopar Cloud pricing component.
 *
 * Fetches /api/signup/plans (optionally filtered by ?category=...) and renders
 * either one card per Price (group_by=price) or one card per Product with
 * multiple Price choices inside the dialog (group_by=product). The dialog
 * fields adapt to the selected Price's category and custom_unit_amount:
 *
 *   - cloud → workspace_name + email (creates a tenant)
 *   - service → email only
 *   - donation → email + (optional) custom amount input when the underlying
 *                 Price has custom_unit_amount enabled
 *
 * Submitting POSTs to /api/signup/create; the response carries the Stripe
 * Checkout URL which we redirect to.
 *
 * Single source of truth = Stripe. No local Plan entity is consulted.
 */

function formatPrice(amount, currency, interval) {
  if (amount == null) return "";
  const value = (amount / 100).toFixed(2);
  const cur = (currency || "").toUpperCase();
  return interval ? `${cur} ${value} / ${interval}` : `${cur} ${value}`;
}

function priceLabel(plan) {
  if (plan.custom_unit_amount) {
    const preset = plan.custom_unit_amount.preset;
    if (preset != null) {
      return `From ${formatPrice(preset, plan.currency, plan.interval)}`;
    }
    return "Custom amount";
  }
  return formatPrice(plan.amount, plan.currency, plan.interval);
}

function defaultCtaLabel(price, category) {
  if (category === "donation") return "Donate";
  if (!price) return "Choose";
  if (price.type === "recurring") return "Subscribe";
  return "Pay";
}

function parseFeatures(meta) {
  const raw = meta?.features;
  if (!raw || typeof raw !== "string") return [];
  return raw.split("|").map(s => s.trim()).filter(Boolean);
}

function cardHeadline(card) {
  if (card.prices.length === 1) return priceLabel(card.prices[0]);
  let minPrice = null;
  let minAmount = Infinity;
  for (const p of card.prices) {
    const amt = p.amount != null
      ? p.amount
      : (p.custom_unit_amount?.preset != null
        ? p.custom_unit_amount.preset
        : p.custom_unit_amount?.minimum);
    if (amt != null && amt < minAmount) {
      minAmount = amt;
      minPrice = p;
    }
  }
  if (!minPrice) return "Multiple options";
  return `From ${formatPrice(minAmount, minPrice.currency, minPrice.interval)}`;
}

function cardCategory(card) {
  return String(card.product_metadata?.category || "cloud").toLowerCase();
}

export default function StripePlans(props) {
  const {
    data: {
      title = "",
      subtitle = "",
      button_label = "",
      domain_suffix = ".loopar.build",
      category = "",
      group_by = "price",
    } = {},
    designer = false,
  } = props;

  const [plans, setPlans] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [selectedCard, setSelectedCard] = useState(null);
  const [selectedPriceId, setSelectedPriceId] = useState(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (designer) {
      setLoading(false);
      setPlans([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const url = category
          ? `/api/signup/plans?category=${encodeURIComponent(category)}`
          : "/api/signup/plans";
        const res = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        const json = await res.json();
        if (cancelled) return;
        if (json?.success && Array.isArray(json.plans)) {
          setPlans(json.plans);
        } else {
          setLoadError(json?.message || "Failed to load plans");
        }
      } catch (err) {
        if (!cancelled) setLoadError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [designer, category]);

  // Group plans into cards. group_by=product collapses multiple Prices of the
  // same Product into a single card; the dialog later lets the user pick one.
  const cards = useMemo(() => {
    if (!plans) return null;
    if (group_by !== "product") {
      return plans.map(p => ({
        key: p.price_id,
        product_id: p.product_id,
        name: p.name,
        description: p.description,
        product_metadata: p.product_metadata,
        prices: [p],
      }));
    }
    const groups = new Map();
    for (const p of plans) {
      const key = p.product_id || p.name;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          product_id: key,
          name: p.name,
          description: p.description,
          product_metadata: p.product_metadata,
          prices: [],
        });
      }
      groups.get(key).prices.push(p);
    }
    return Array.from(groups.values());
  }, [plans, group_by]);

  const selectedPrice = useMemo(() => {
    if (!selectedCard) return null;
    return selectedCard.prices.find(p => p.price_id === selectedPriceId)
      || selectedCard.prices[0]
      || null;
  }, [selectedCard, selectedPriceId]);

  const openFor = (card) => {
    setSelectedCard(card);
    const first = card.prices[0];
    setSelectedPriceId(first?.price_id || null);
    setWorkspaceName("");
    setEmail("");
    const preset = first?.custom_unit_amount?.preset;
    setAmount(preset != null ? (preset / 100).toString() : "");
    setFormError(null);
    setSubmitting(false);
  };

  const close = () => {
    setSelectedCard(null);
    setSelectedPriceId(null);
  };

  // Picking a different Price inside a grouped card resets the amount to that
  // Price's preset (if it's a custom_unit_amount one).
  const pickPrice = (priceId) => {
    setSelectedPriceId(priceId);
    const p = selectedCard?.prices.find(x => x.price_id === priceId);
    const preset = p?.custom_unit_amount?.preset;
    setAmount(preset != null ? (preset / 100).toString() : "");
    setFormError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedCard || !selectedPrice) return;

    const sCategory = cardCategory(selectedCard);
    const needsWorkspace = sCategory === "cloud";
    const needsAmount = !!selectedPrice.custom_unit_amount;

    const em = email.trim().toLowerCase();
    if (!em) {
      setFormError("Email is required");
      return;
    }

    const body = {
      price_id: selectedPrice.price_id,
      email: em,
    };

    if (needsWorkspace) {
      const ws = workspaceName.trim().toLowerCase();
      if (!ws) {
        setFormError("Workspace name is required");
        return;
      }
      body.workspace_name = ws;
      // Website template picked on the Templates page (/pricing?template=…).
      const template = typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("template")
        : null;
      if (template) body.template = template;
    }

    if (needsAmount) {
      const a = Number(amount);
      if (!a || !Number.isFinite(a) || a <= 0) {
        setFormError("Please enter a valid amount");
        return;
      }
      body.amount = a;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/signup/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json?.success && json.url) {
        window.location.href = json.url;
        return;
      }
      setFormError(json?.message || "Signup failed");
      setSubmitting(false);
    } catch (err) {
      setFormError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full">
      {title && (
        <h2 className="text-3xl font-bold text-center mb-2">{title}</h2>
      )}
      {subtitle && (
        <p className="text-center text-muted-foreground mb-8">{subtitle}</p>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin opacity-70" />
        </div>
      )}

      {loadError && (
        <div className="text-center py-8 text-destructive">{loadError}</div>
      )}

      {!loading && !loadError && cards && cards.length === 0 && (
        <p className="text-center text-muted-foreground py-8">
          {designer
            ? "Plans will appear here once available in Stripe."
            : "No plans available."}
        </p>
      )}

      {!loading && !loadError && cards && cards.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {cards.map((card) => {
            const features = parseFeatures(card.product_metadata);
            const isPopular = String(card.product_metadata?.popular || "") === "1";
            const cat = cardCategory(card);
            // CTA label uses the first Price as the reference for "Subscribe / Pay"
            // when the card has many Prices, all of them tend to be the same type.
            const cta = button_label || defaultCtaLabel(card.prices[0], cat);

            return (
              <div
                key={card.key}
                className={cn(
                  "relative flex flex-col rounded-xl border bg-card p-6",
                  "shadow-sm hover:shadow-md transition-shadow",
                  isPopular ? "border-primary ring-1 ring-primary/30" : "border-border"
                )}
              >
                {isPopular && (
                  <span
                    className={cn(
                      "absolute -top-3 right-4 px-2 py-0.5 rounded-full text-xs font-medium",
                      "bg-primary text-primary-foreground shadow-sm"
                    )}
                  >
                    {__("Most Popular")}
                  </span>
                )}

                <h3 className="text-xl font-semibold mb-1">{card.name}</h3>
                {card.description && (
                  <p className="text-sm text-muted-foreground mb-4">
                    {card.description}
                  </p>
                )}

                <div className="mt-2 mb-4">
                  <span className="text-3xl font-bold">{cardHeadline(card)}</span>
                </div>

                {features.length > 0 && (
                  <ul className="text-sm text-muted-foreground space-y-1 mb-6">
                    {features.map((f, i) => (
                      <li key={i} className="flex items-start">
                        <span className="mr-2 text-primary">•</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <Button
                  type="button"
                  className="mt-auto"
                  onClick={() => openFor(card)}
                >
                  {cta}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={!!selectedCard}
        onOpenChange={(open) => { if (!open) close(); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {selectedCard
                ? `${defaultCtaLabel(selectedPrice, cardCategory(selectedCard))} — ${selectedCard.name}`
                : ""}
            </DialogTitle>
            {selectedCard && selectedCard.prices.length === 1 && selectedPrice && (
              <DialogDescription>
                {priceLabel(selectedPrice)}
              </DialogDescription>
            )}
          </DialogHeader>

          {selectedCard && selectedPrice && (() => {
            const sCategory = cardCategory(selectedCard);
            const needsWorkspace = sCategory === "cloud";
            const needsAmount = !!selectedPrice.custom_unit_amount;
            const hasMultiple = selectedCard.prices.length > 1;
            const cu = selectedPrice.custom_unit_amount || {};

            const submitLabel = (() => {
              const verb = defaultCtaLabel(selectedPrice, sCategory);
              if (needsAmount) {
                const a = Number(amount);
                if (a > 0) {
                  return `${verb} ${formatPrice(Math.round(a * 100), selectedPrice.currency, selectedPrice.interval)}`;
                }
                return verb;
              }
              return `${verb} — ${formatPrice(selectedPrice.amount, selectedPrice.currency, selectedPrice.interval)}`;
            })();

            return (
              <form onSubmit={handleSubmit} className="space-y-4">
                {hasMultiple && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{__("Choose an option")}</label>
                    <div className="space-y-1">
                      {selectedCard.prices.map((p) => (
                        <label
                          key={p.price_id}
                          className={cn(
                            "flex items-center gap-3 p-2 rounded-md border cursor-pointer transition-colors",
                            selectedPriceId === p.price_id
                              ? "border-primary bg-primary/5"
                              : "border-border hover:bg-accent"
                          )}
                        >
                          <input
                            type="radio"
                            name="price-option"
                            value={p.price_id}
                            checked={selectedPriceId === p.price_id}
                            onChange={() => pickPrice(p.price_id)}
                            disabled={submitting}
                            className="accent-primary"
                          />
                          <span className="text-sm">{priceLabel(p)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {needsAmount && (
                  <div className="space-y-1">
                    <label className="text-sm font-medium">{__("Amount (USD)")}</label>
                    <Input
                      type="number"
                      step="1"
                      min={cu.minimum != null ? (cu.minimum / 100) : 1}
                      max={cu.maximum != null ? (cu.maximum / 100) : undefined}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={cu.preset != null ? (cu.preset / 100).toString() : "25"}
                      required
                      disabled={submitting}
                    />
                    {(cu.minimum != null || cu.maximum != null) && (
                      <p className="text-xs text-muted-foreground">
                        {cu.minimum != null && `Min ${formatPrice(cu.minimum, selectedPrice.currency)}`}
                        {cu.minimum != null && cu.maximum != null && " · "}
                        {cu.maximum != null && `Max ${formatPrice(cu.maximum, selectedPrice.currency)}`}
                      </p>
                    )}
                  </div>
                )}

                {needsWorkspace && (
                  <div className="space-y-1">
                    <label className="text-sm font-medium">{__("Workspace name")}</label>
                    <Input
                      value={workspaceName}
                      onChange={(e) => setWorkspaceName(e.target.value.toLowerCase())}
                      placeholder="acmeco"
                      pattern="[a-z][a-z0-9-]{1,28}[a-z0-9]"
                      required
                      disabled={submitting}
                    />
                    <p className="text-xs text-muted-foreground">
                      {__("Your workspace will be at")}{" "}
                      <code className="text-foreground">
                        {(workspaceName || "your-name") + domain_suffix}
                      </code>
                    </p>
                  </div>
                )}

                <div className="space-y-1">
                  <label className="text-sm font-medium">{__("Email")}</label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    disabled={submitting}
                  />
                </div>

                {formError && (
                  <div className="text-sm text-destructive">{formError}</div>
                )}

                <DialogFooter className="gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={close}
                    disabled={submitting}
                  >
                    {__("Cancel")}
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting ? "Redirecting…" : submitLabel}
                  </Button>
                </DialogFooter>
              </form>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}

StripePlans.metaFields = () => {
  return [[
    {
      group: "content",
      elements: {
        title: {
          element: INPUT,
          data: {
            label: "Title",
            description: "Heading displayed above the cards.",
            default: "",
          },
        },
        subtitle: {
          element: INPUT,
          data: {
            label: "Subtitle",
            description: "Subheading displayed below the title.",
            default: "",
          },
        },
        category: {
          element: SELECT,
          data: {
            label: "Category",
            description: "Filter plans by Product.metadata.category in Stripe. Leave empty to show all.",
            options: [
              { option: "All", value: "" },
              { option: "Cloud", value: "cloud" },
              { option: "Services", value: "service" },
              { option: "Donations", value: "donation" },
            ],
            default: "",
          },
        },
        group_by: {
          element: SELECT,
          data: {
            label: "Group by",
            description: "Show one card per Price (default), or one card per Product with multiple Price choices inside the dialog (useful for donation tiers or monthly/annual options).",
            options: [
              { option: "Price (one card per Price)", value: "price" },
              { option: "Product (one card per Product, choices in dialog)", value: "product" },
            ],
            default: "price",
          },
        },
        button_label: {
          element: INPUT,
          data: {
            label: "Button label override",
            description: "If set, all cards use this label. Otherwise the label is contextual (Subscribe / Pay / Donate).",
            default: "",
          },
        },
        domain_suffix: {
          element: INPUT,
          data: {
            label: "Domain suffix",
            description: "Shown after the workspace name in the cloud signup dialog (e.g. .loopar.build).",
            default: ".loopar.build",
          },
        },
      },
    },
  ]];
};
