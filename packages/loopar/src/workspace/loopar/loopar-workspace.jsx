import BaseWorkspace from "@workspace/base/base-workspace";
import { useWorkspace } from "@workspace/workspace-provider";
import SystemShell from "../system/system-shell";

/**
 * System pages (install wizard, update): the system shell with a wide card.
 * The wizard needs the width the auth card doesn't have.
 */
export default function LooparWorkspace() {
  const { ActiveView } = useWorkspace();

  return (
    <BaseWorkspace>
      <SystemShell width="3xl">{ActiveView}</SystemShell>
    </BaseWorkspace>
  );
}
