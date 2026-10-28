import { loopar } from "loopar";

/**
 * Saving a record that belongs to an app's installer (include_in_installer +
 * app) bumps that app and rewrites apps/<app>/installer.json from the tenant's
 * database — in a test tenant that would overwrite the repo's file. Tests that
 * save such records call this inside `t.run` first.
 */
export async function keepInstallersUntouched() {
  const App = (await loopar.newDocument("App")).constructor;
  App.prototype.bump = async () => true;
}
