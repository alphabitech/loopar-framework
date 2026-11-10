/** Contact link builders shared by contact_links and whatsapp_button. */
export const digits = (v) => String(v ?? "").replace(/\D/g, "");

export const telUrl = (phone) => (digits(phone) ? `tel:+${digits(phone)}` : null);

export const whatsappUrl = (phone, message) => {
  const number = digits(phone);
  if (!number) return null;
  return `https://wa.me/${number}${message ? `?text=${encodeURIComponent(message)}` : ""}`;
};

export const mapsUrl = (address) =>
  address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null;

/** Accepts a full URL or a bare domain/handle URL ("facebook.com/acme"). */
export const absoluteUrl = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};
