'use strict';

import { BareLayout } from '@loopar/form';
import { SystemHeader } from '@workspace/system/system-shell';
import { __ } from "loopar";

export default function ResetPasswordRequestForm() {
  return (
    <>
      <SystemHeader
        title={__("Reset your password")}
        description={__("Enter your email and we'll send you a link to reset it.")}
      />
      <BareLayout />
    </>
  );
}
