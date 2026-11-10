import BaseWorkspace from "@workspace/base/base-workspace";
import { useWorkspace } from "@workspace/workspace-provider";
import SystemShell from "../system/system-shell";

export { AuthBackdrop } from "../system/system-shell";

/** Auth pages (login, recovery, 2FA): the system shell with a narrow card. */
export default function AuthWorkspace() {
  const { ActiveView } = useWorkspace();

  return (
    <BaseWorkspace>
      <SystemShell width="md">
        <div className="flex flex-col gap-4">{ActiveView}</div>
      </SystemShell>
    </BaseWorkspace>
  );
}
