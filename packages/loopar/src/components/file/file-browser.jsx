import { Modal } from "@dialog";
import { Entity } from "@loopar/loader";
import { __ } from "@global/i18n";

export function Browser(props) {
  return (
    <Entity
      name="File Manager"
      action="list"
      hasBreadcrumb={false}
      hasSidebar={false}
      {...props}
      inModal={false}
    />
  );
}

export function FileBrowser(props) {
  return (
    <Modal
      position="top"
      size="full"
      title={__("File Browser")}
      scrollable={true}
      open={true}
      onClose={() => {
        props.onClose && props.onClose();
      }}
    >
      <Browser {...props} inModal={props.inModal}/>
    </Modal>
  );
}
