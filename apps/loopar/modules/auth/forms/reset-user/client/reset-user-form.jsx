'use strict';

import { BareLayout } from '@loopar/form';
import { SystemHeader } from '@workspace/system/system-shell';
import { __ } from "loopar";

export default function ResetUserForm() {
  return (
    <>
      <SystemHeader
        title={__("Forgot your username?")}
        description={__("If an account is registered with that email, we'll send you its username.")}
      />
      <BareLayout />
    </>
  );
}
