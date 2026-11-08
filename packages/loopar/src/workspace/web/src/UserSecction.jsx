import { Modal } from "@dialog";
import { Entity } from "@loopar/loader";
import { __ } from "@global/i18n";

export function Profile(props) {
  return (
    <Modal open={true} size="lg" title={__("Profile")} onClose={props.onClose} buttons={[]}>
      <Entity
        name="Profile"
        action="update"
        hasBreadcrumb={false}
        hasSidebar={false}
        inModal
        onClose={props.onClose}
      />
    </Modal>
  );
}
