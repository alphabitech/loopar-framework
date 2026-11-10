'use strict';

import fs from "fs";
import path from "pathe";
import { registerElements } from "./element-definition.js";

/**
 * Registers the page-builder elements every app ships in
 * `apps/<app>/elements/elements.json` (see registerElements). Elements of
 * every app are known to the server — rendering never depends on the
 * tenant — and the designer palette only offers those of installed apps.
 */
export function loadAppElements(pathRoot) {
  const appsDir = path.join(pathRoot, "apps");
  let apps = [];
  try { apps = fs.readdirSync(appsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return; }

  for (const app of apps) {
    const manifest = path.join(appsDir, app, "elements", "elements.json");
    if (!fs.existsSync(manifest)) continue;
    try {
      registerElements(JSON.parse(fs.readFileSync(manifest, "utf8")), app);
    } catch (error) {
      console.error(`[app-elements] ${app}: invalid elements.json`, error?.message || error);
    }
  }
}
