import fileManager from "@@file/file-manager";
import { useLetterhead } from "./record";

export function LetterheadBlock({ letterhead: explicit, aside = null }) {
  const current = useLetterhead();
  const lh = explicit !== undefined ? explicit : current;
  if (!lh) return null;

  const logo = (fileManager.getMappedFiles(lh.logo) || []).find((f) => f?.src);
  const contact = [lh.phone, lh.email, lh.website].filter(Boolean);

  return (
    <header className="lp-letterhead">
      <div className="lp-letterhead-brand">
        {logo && <img className="lp-letterhead-logo" src={logo.src} alt={lh.company_name || ""} />}
        <div>
          <div className="lp-letterhead-name">{lh.company_name}</div>
          {lh.legal_name && lh.legal_name !== lh.company_name && <div className="lp-letterhead-muted">{lh.legal_name}</div>}
          {lh.tagline && <div className="lp-letterhead-muted">{lh.tagline}</div>}
        </div>
      </div>
      <div className="lp-letterhead-contact">
        {aside}
        {lh.address && <div className="lp-multiline">{lh.address}</div>}
        {contact.length > 0 && <div>{contact.join(" · ")}</div>}
        {lh.tax_id && <div>{lh.tax_id_label || "Tax ID"}: {lh.tax_id}</div>}
      </div>
    </header>
  );
}

export function LetterheadFooter({ letterhead: explicit }) {
  const current = useLetterhead();
  const lh = explicit !== undefined ? explicit : current;
  if (!lh?.footer) return null;
  return <footer className="lp-letterhead-footer lp-multiline">{lh.footer}</footer>;
}
