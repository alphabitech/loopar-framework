'use strict';

import { FormLayout } from '@loopar/form';
import ThemeCustomizer from "./src/theme";

const SLOTS = { theme: ThemeCustomizer };

export default function SystemSettingsForm() {
  return <FormLayout slots={SLOTS} />;
}
