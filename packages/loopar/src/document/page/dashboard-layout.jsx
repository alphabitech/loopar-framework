import DeskUI from "../chrome/desk-ui";
import { defineLayout } from "../base/define-layout";
import { useDocument } from "../base/provider";
import { DashboardBoard } from "@loopar/components/desk/dashboard-board";

function DashboardBody() {
  const { Document } = useDocument();
  const data = Document?.data || {};

  return <DashboardBoard name={data.name || Document?.name} description={data.description} items={data.items} link="edit" />;
}

/** Dashboard record opened with `view`: the board instead of the form. */
export const DashboardLayout = defineLayout("DashboardLayout", ({ ctrl, children }) => (
  <DeskUI docRef={ctrl}>
    <DashboardBody />
    {children}
  </DeskUI>
));
