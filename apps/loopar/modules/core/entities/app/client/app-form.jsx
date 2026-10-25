'use strict';

import { useForm, FormLayout } from '@loopar/form';
import { loopar } from 'loopar';
import { Button } from '@cn/components/ui/button';
import { ArrowUp } from 'lucide-react';
import { useState } from 'react';
import ThemeCustomizer from '../../system-settings/client/src/theme';

/**
 * Optional per-app theme, used on the app's site domains. Off = no value, so
 * the tenant theme (System Settings) applies. The editor is opt-in because it
 * emits a value as soon as it mounts.
 */
function AppThemeSlot(props) {
  const { getValue, setValue } = useForm();
  const [own, setOwn] = useState(() => !!loopar.utils.JSONparse(getValue('theme'), {})?.theme);

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={own}
          onChange={(e) => {
            setOwn(e.target.checked);
            if (!e.target.checked) {
              setValue('theme', '');
              document.getElementById('loopar-theme-styles')?.remove(); // drop the live preview
            }
          }}
        />
        Own theme for this app's sites (otherwise the System Settings theme applies)
      </label>
      {own && <ThemeCustomizer {...props} />}
    </div>
  );
}

const SLOTS = { theme: AppThemeSlot };

export default function AppForm() {
  const { getValue, setValue } = useForm();

  const incrementVersion = (type) => (
    <Button
      variant="link"
      onClick={(e) => {
        e.preventDefault();
        const name = getValue('name');

        loopar.confirm(`Are you sure you want to increment the ${type} version of the app ${name}?`, () => {
          loopar.call("App", `increment${type}`, {
            query: { name },
            success: (result) => setValue('version', result.version),
          });
        });
      }}
    >
      <ArrowUp className="mr-2" />
      {type === 'Patch' ? 'Increment Patch' : type === 'Minor' ? 'Increment Minor' : 'Increment Major'}
    </Button>
  );

  return (
    <FormLayout
      slots={SLOTS}
      actionsInMenu
      actions={{
        incrementPatch: incrementVersion('Patch'),
        incrementMinor: incrementVersion('Minor'),
        incrementMajor: incrementVersion('Major'),
      }}
    />
  );
}
