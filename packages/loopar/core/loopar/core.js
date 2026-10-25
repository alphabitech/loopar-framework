
import inflection, { titleize, singularize } from "inflection";
import { elementsDict } from "loopar";
import fs from "fs";
import path from "pathe";
import { fileManage } from "../file-manage.js";
import { Builder } from "./builder.js";

export class Core extends Builder {
  getApps() {
    const baseApps = this.getDirList(this.makePath(this.pathRoot, "apps")).map(app => {
      return {
        ...app,
        appRoot: this.makePath("apps", app.name)
      }
    });

    const pathCore = this.pathCore.split(this.pathRoot).pop();
    const coreApp = this.getDirList(this.makePath(this.pathRoot, pathCore, "apps")).map(app => {
      return {
        ...app,
        appRoot: this.makePath(pathCore, "apps", app.name)
      }
    });

    return [...coreApp, ...baseApps];
  }

  getEntities(appName) {
    return this.getApps().reduce((acc, app) => {
      if (appName && !this.utils.compare(app.name, appName)) return acc;

      const moduleRoot = this.makePath(this.pathRoot, app.appRoot, `modules`);
      const modules = this.getDirList(moduleRoot);

      modules.forEach(module => {
        const coresRoot = path.resolve(`${moduleRoot}/${module.name}`);
        const cores = this.getDirList(coresRoot) || [];

        cores.forEach(core => {
          const entitiesRoot = path.resolve(`${coresRoot}/${core.name}`);
          const entities = this.getDirList(entitiesRoot);

          entities.forEach(entity => {
            let data = this.getFile(this.makePath(entitiesRoot, entity.name, entity.name) + ".json");

            if (data) {
              data = this.utils.isJSON(data) ? JSON.parse(data) : null;
              // `__deleted_at__` is the canonical tombstone signal at
              // both DB and FS levels (Task #88). makeJSON preserves the
              // timestamp for soft-deleted entities and strips it for
              // active ones, so the FS read aligns with the DB row.
              if (!data.__deleted_at__) {
                data.entityRoot = this.makePath(app.appRoot, "modules", module.name, core.name, entity.name);
                // Folder → type: "print-formats" → "Print Format" (dashes are word
                // separators; titleize alone keeps them: "Print-Format").
                data.type = titleize(singularize(core.name.replaceAll("-", " ")));
                data.__MODULE__ = module.name;
                //replace all - with space and titleize
                data.__APP__ = app.name//titleize(humanize(app.name)).replace(/-/g, ' ');

                acc.push(data);
              }
            } else {
              console.log([`Entity [${entity.name}] not found`]);
            }
          });
        });
      });

      return acc;
    }, []);
  }

  entityIsSingle(ENT) {
    return (["Page", "Form", "Report", "View", "Controller", "Print Format", "Desk Page"].includes(ENT.type) || ENT.is_single) ? 1 : 0;
  }

  getRef(entity) {
    return this.__REFS__[this.utils.toEntityKey(entity)] || null;
  }
  
  getRefs(app, alls = false) {
    if (app) {
      const appKey = inflection.transform(app, ['capitalize', 'dasherize']).toLowerCase();
      return this.__REFS_BY_APP__[appKey] || {};
    }
  
    if (alls) return this.__REFS__;
  
    const installedSet = new Set([
      'loopar', 'core',
      ...Object.keys(this.installedApps).map(
        a => inflection.transform(a, ['capitalize', 'dasherize']).toLowerCase()
      )
    ]);
  
    const result = {};
    for (const key in this.__REFS__) {
      if (installedSet.has(this.__REFS__[key].__APP_KEY__)) {
        result[key] = this.__REFS__[key];
      }
    }
    return result;
  }

  getType(type) {
    return this.getTypes()[type];
  }

  getTypes(app) {
    const types = this.__TYPES__;

    if (app) {
      return Object.values(types).filter(type => type.__APP__ === app);
    }

    return types;
  }

  eachAppsSync(fn) {
    fs.readdirSync(this.makePath(this.pathRoot, "apps")).forEach(app => {
      if (fs.lstatSync(this.makePath(this.pathRoot, "apps", app)).isDirectory()) {
        fn(app);
      }
    });
  }

  getDirList(path) {
    return fs.readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory());
  }

  getFile(path) {
    return !fs.existsSync(path) ? null : fs.readFileSync(path, 'utf8');
  }

  async appStatus(appName) {
    return await this.db.getValue('App', 'name', appName) ? 'installed' : 'uninstalled';
  }

  /** The app's installer instance (apps/<app>/installer.js), or null. */
  async getInstaller(appName) {
    if (!appName) return null;
    const route = this.makePath('apps', appName, 'installer.js');
    const Cls = await fileManage.importClass(route, () => null);
    if (!Cls) return null;
    return new Cls({ app_name: appName });
  }

  async unInstallApp(appName) {
    if (this.installing) {
      // Not this.throw(): it clears installingApp, which belongs to the
      // operation that is still running.
      const err = new Error(`Another app operation is in progress (${this.installingApp}). Try again when it finishes.`);
      Object.assign(err, { status: 409, code: 'APP_OPERATION_IN_PROGRESS', title: 'Uninstall' });
      throw err;
    }
    const installerRoute = this.makePath('apps', appName, 'installer.js');

    const installer = await fileManage.importClass(installerRoute, () => {
      this.throw(`App ${appName} does not have an installer`);
    });

    const Installer = new installer({ app_name: appName });
    return await Installer.unInstall();
  }

  async getApp(appName) {
    if (await this.appStatus(appName) === 'installed') {
      return await this.db.getDoc('App', appName);
    } else {
      return null;
    }
  }

  getUniqueKey() {
    return "k"+Math.random().toString(36).substr(2, 9);
  }
}