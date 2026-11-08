import { __ } from "@global/i18n";
export default function noData() {
  return (
    <div className="empty-state">
      <div className="empty-state-container">
        <div className="state-figure">
          <img
            className="img-fluid"
            src="/assets/images/illustration/img_nodatafound.svg"
          />
        </div>
        <h3 className="state-header">{__("No Content, Yet.")}</h3>
        <p className="state-description lead text-muted">
          {__("Use the button below to add content.")}
        </p>
        <div className="state-action">
          <a className="btn btn-primary btn-lg" href="">
            {__("Add Content")}
          </a>
        </div>
      </div>
    </div>
  );
}
