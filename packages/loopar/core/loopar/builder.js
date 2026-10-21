import { GlobalEnvironment } from '../global/element-definition.js';
import path from "pathe";
import dayjs from "dayjs";
import crypto from "crypto-js";
import * as lucideIcons from 'lucide-react';
import * as simpleIcons from 'simple-icons';

import { fileManage } from "../file-manage.js";
import { elementsDict, elementsDefinition } from "../global/element-definition.js";
import { isAuditableEntity, AUDIT_COLUMN_NAMES } from "../global/audit.js";
import {PermissionManager} from "../auth/PermissionManager.js"
import { existsSync, readdirSync, readFileSync } from "fs";

import inflection from "inflection";
import { shouldRunJobs } from "../config/core-config.js";
import { tenant } from "../../bin/tenant/tenant-builder.js";

export class Builder {
  async buildRefs() {
    let types = {};
    const docs = this.getEntities();
  
    const getEntityFields = (fields, { auditable = false } = {}) => {
      const getFields = fields => fields.reduce((acc, field) =>
        acc.concat(field, ...getFields(field.elements || [])), []);

      const declared = getFields(fields).filter(field => {
        const def = elementsDict[field.element]?.def || {};
        return def.isWritable && !!field.data.name;
      }).map(field => field.data.name);

      const out = ["id", ...declared];
      if (auditable) out.push(...AUDIT_COLUMN_NAMES);

      return [...new Set(out)];
    }

    // FORM_TABLE fields live in __FIELDS__ so the save chain (childValuesReq
    // → #makeFields → DynamicField) picks them up, but they have no
    // physical column in the parent table. DB-column-aware consumers
    // (testFramework, SELECT-building helpers) read this list to skip them.
    const getFormTableFields = (fields) => {
      const getAll = fields => fields.reduce((acc, field) =>
        acc.concat(field, ...getAll(field.elements || [])), []);
      return getAll(fields)
        .filter(field => field.element === FORM_TABLE && !!field.data?.name)
        .map(field => field.data.name);
    }
  
    const refs = {};
    const types_ = {};
    const refsByApp = {};
  
    for (const doc of Object.values(docs)) {
      if (doc.__deleted_at__) continue;
  
      const isBuilder = (doc.build || ['Builder', 'Entity'].includes(doc.name)) ? 1 : 0;
      const isChild = doc.is_child ? 1 : 0;
      const isVirtual = doc.is_virtual ? 1 : 0;
      const isSingle = this.entityIsSingle(doc);
      const fields = this.utils.JSONparse(doc.doc_structure, []);

      const id = parseInt(doc.id) || 0;

      const appKey = inflection.transform(doc.__APP__, ['capitalize', 'dasherize']).toLowerCase();
    
      const auditable = isAuditableEntity({
        name: doc.name,
        is_static: doc.is_static,
        is_child: isChild,
        is_single: isSingle,
        is_virtual: isVirtual,
        is_audited: doc.is_audited,
      });

      const ref = {
        id,
        __NAME__: doc.name,
        __APP__: doc.__APP__,
        __APP_KEY__: appKey,
        __ENTITY__: doc.__ENTITY__ || "Entity",
        __ROOT__: doc.entityRoot,
        is_single: isSingle,
        is_builder: isBuilder,
        is_child: isChild,
        is_virtual: isVirtual,
        is_audited: auditable ? 1 : 0,
        enable_history: this.utils.trueToBinary(doc.enable_history),
        enable_comments: this.utils.trueToBinary(doc.enable_comments),
        require_login_to_comment: this.utils.trueToBinary(doc.require_login_to_comment),
        __MODULE__: doc.__MODULE__,
        __TYPE__: doc.type,
        __FIELDS__: getEntityFields(fields, { auditable }),
        __FORM_TABLE_FIELDS__: getFormTableFields(fields)
      };
  
      const key = this.utils.toEntityKey(doc.name);
      const clash = refs[key];
      if (clash && clash.__APP_KEY__ !== appKey) {
        // Entity names are unique per tenant. Two apps shipping the same name
        // would shadow each other here (the later one's files get rendered):
        // make it loud. The installer refuses to install the second one.
        console.error(
          `[refs] name collision: "${doc.name}" (${doc.__ENTITY__ || 'Entity'} in app "${doc.__APP__}") ` +
          `shadows "${clash.__NAME__}" (${clash.__ENTITY__} in app "${clash.__APP__}"). Rename one of them.`
        );
      }
      refs[key] = ref;
  
      if (!refsByApp[appKey]) refsByApp[appKey] = {};
      refsByApp[appKey][key] = ref;
  
      if (isBuilder) {
        types_[doc.name] = {
          id,
          __ROOT__: doc.entityRoot,
          __NAME__: doc.name,
          __ENTITY__: doc.__ENTITY__ || "Entity",
          __BUILD__: doc.build || doc.name,
          __APP__: doc.__APP__,
          __ID__: doc.id,
          __TYPE__: doc.type,
          __MODULE__: doc.__MODULE__,
          __FIELDS__: getEntityFields(fields, { auditable }),
          __FORM_TABLE_FIELDS__: getFormTableFields(fields)
        };
      }
    }
  
    this.__REFS__ = refs;
    this.__TYPES__ = types_;
    this.__REFS_BY_APP__ = refsByApp;
  }

  makePath(...args) {
    let pathArray = args;

    if (!args[0].startsWith("./")) {
      pathArray = ["/", ...args];
    }

    const joinedPath = path.join(...pathArray);

    return this.utils.decamelize(joinedPath, { separator: '-' });
  }

  async buildIcons() {
    if (!this.__installed__) return;
    const refs = this.getRefs();
  
    const directIcons = [];
  
    const evalFields = (fields) => {
      fields = Array.isArray(fields) ? fields : [];
      return fields.reduce((acc, field) => {
        if (field.element === ICON_INPUT) {
          acc.push(field.data.name);
        }
        if (field.element === ICON || field.element === TEXT_BLOCK_ICON) {
          directIcons.push(field.data.icon);
        }
        if (field.elements) {
          acc.push(...evalFields(field.elements));
        }
        return acc;
      }, []);
    };
  
    const refIcons = {};
    Object.values(refs).forEach(ref => {
      const docJson = fileManage.getConfigFile(
        ref.__NAME__.replaceAll(' ', '-').toLowerCase(),
        ref.__ROOT__
      );
      if (docJson?.doc_structure) {
        const fields = evalFields(
          this.utils.JSONparse(docJson.doc_structure, docJson.doc_structure)
        );
        if (fields.length) refIcons[ref.__NAME__] = { fields, isSingle: ref.is_single };
      }
    });
  
    const iconImports = new Set();
    for (const [entity, ent] of Object.entries(refIcons)) {
      if (!ent.isSingle) {
        if (
          (await this.db.hasEntity(null, entity)) &&
          (await this.db.hasTable(entity))
        ) {
          for (const res of await this.db.getAll(entity, ent.fields)) {
            for (const field of ent.fields) {
              const icon = (res[field] || '').replaceAll(/[- ]/g, '');
              if (icon) iconImports.add(icon);
            }
          }
        }
      }
    }
  
    Object.values(elementsDefinition).forEach(ed => {
      ed.forEach(d => directIcons.push(d.icon));
    });
  
    const tenantIcons = Array.from(new Set([...iconImports, ...directIcons])).filter(Boolean);
  
    await fileManage.makeFile(
      'app/auto/icon-segments',
      this.tenantId,
      JSON.stringify(tenantIcons),
      'json',
      true
    );
  
    const segmentsDir = path.join(this.pathRoot, 'app/auto/icon-segments');
    const segmentFiles = existsSync(segmentsDir)
      ? readdirSync(segmentsDir).filter(f => f.endsWith('.json'))
      : [];
  
    const allIcons = Array.from(new Set(
      segmentFiles.flatMap(file => {
        try {
          return JSON.parse(readFileSync(path.join(segmentsDir, file), 'utf-8'));
        } catch {
          return [];
        }
      })
    )).filter(Boolean);
  
    const toSimpleKey  = (name) => name.charAt(0).toLowerCase() + name.slice(1);
    const isSimpleIcon = (name) => /^Si[A-Z]/.test(name);
  
    const lucideIconNames = allIcons
      .filter(name => !isSimpleIcon(name) && lucideIcons[name]);
  
    const simpleIconNames = allIcons
      .filter(name => isSimpleIcon(name) && simpleIcons[toSimpleKey(name)]);
  
    const lines = ['// this file is autogenerated — do not edit by hand'];
  
    if (lucideIconNames.length) {
      lines.push(`export { ${lucideIconNames.join(', ')} } from "lucide-react";`);
    }
  
    // Per-icon imports (not the barrel) so dev only loads the icons actually
    // used — importing from the barrel pulls all ~3000 simple-icons in dev.
    for (const name of simpleIconNames) {
      lines.push(`export { default as ${name} } from "@icons-pack/react-simple-icons/icons/${name}.mjs";`);
    }
  
    await fileManage.makeFile(
      'app/auto',
      'preloaded-icons',
      lines.join('\n'),
      'jsx',
      true
    );
  }

  async build() {
    console.log('......Building Loopar.......');

    await this.makeDefaultFolders();
    if (this.installingApp) return;

    await this.buildRefs();
   
    const writeFile = async (data) => {
      await fileManage.setConfigFile('loopar.config', data);

      await this.loadConfig(data);
    }

    const writeModules = async (data) => {
      this.db.pagination = null;
      const groupList = await this.db.getList('Module Group', ['name', 'description'], {in_sidebar: 1 });

      for (const g of groupList) {
        const modulesGroup = { name: g.name, description: g.description, modules: [] };

        const moduleList = await this.db.getAll(
          'Module',
          ['name', 'icon', 'description', 'module_group'],
          {module_group: g.name, in_sidebar: 1}
        );

        for (const m of moduleList) {
          const module = { link: m.name, icon: m.icon, description: m.description, routes: [] };

          const routeList = await this.db.getList("Entity", ['name', 'is_single'], {module: m.name});

          module.routes = routeList.map(route => {
            return { link: route.is_single ? 'update' : route.name, description: route.name }
          });

          modulesGroup.modules.push(module);
        }

        data.modulesGroup.push(modulesGroup);
      }

      data.initializedModules = true;
      this.modulesGroup = data.modulesGroup;

      await writeFile(data);
    }

    const data = {
      DBInitialized: this.DBInitialized,
      modulesGroup: []
    };

    this.DBServerInitialized = await this.db.testServer();
    this.DBInitialized = (this.DBServerInitialized && await this.db.testDatabase());
    this.__installed__ = (this.DBInitialized && await this.db.testFramework("loopar"));

    let wasInstalledHint = false;
    if (this.DBInitialized) {
      try {
        if (await this.db.hasTable("App")) {
          wasInstalledHint = (await this.db.count("App", "loopar")) > 0;
        }
      } catch (e) {
        console.warn(
          `[loopar.build] Could not probe App table for __wasInstalled__: ${e.message}`
        );
      }
    }
    this.__wasInstalled__ = this.DBInitialized && (this.__installed__ || wasInstalledHint);

    if (!this.__wasInstalled__ && this.installedApps?.loopar) {
      await this.unsetApp("loopar");
    }

    data.DBInitialized = this.DBInitialized;
    data.DBServerInitialized = this.DBServerInitialized;
    data.__installed__ = this.__installed__;

    if (data.__installed__) {
      const loadWebApp = async (appName) => {
        const webApp = appName ? await this.db.getParseDoc('App', appName) : null;
        return {
          ...(webApp || {}),
          menu_items: webApp ? await this.db.getAll("Menu Item", ["*"], { parent_id: webApp.id }) : [],
          menu_actions: webApp ? await this.db.getAll("Menu Action", ["*"], { parent_id: webApp.id }) : []
        };
      };

      const settings = await this.db.getDoc('System Settings');
      data.webApp = await loadWebApp(settings.active_web_app);

      // One entry per app mapped to a site domain (tenant config `sites`);
      // loopar.webApp picks the request's one by host.
      data.webApps = {};
      const siteApps = new Set(Object.values(tenant.readTenant(this.tenantId)?.sites || {}));
      for (const appName of siteApps) {
        data.webApps[appName] = appName === data.webApp.name ? data.webApp : await loadWebApp(appName);
        if (!data.webApps[appName].name) {
          console.warn(`[sites] web app "${appName}" is not installed in tenant ${this.tenantId}; its domains fall back to the default web app.`);
        }
      }

      await writeModules(data);

      await PermissionManager.boot();

      await this.resumeProvisioningRetry();
    } else {
      await writeFile(data);
    }
  }

  _isControlPlane() {
    return ["1", "true"].includes(String(process.env.CONTROL_PLANE || ""));
  }

  /**
   * Control-plane boot hook: re-run any provisioning that was mid-flight
   * when the previous process died (or that's overdue per its persisted
   * `retry_after`). Best-effort: errors are logged and swallowed because
   * we never want a retry-sweep glitch to block the boot.
   */
  async resumeProvisioningRetry() {
    if (!shouldRunJobs()) return;
    if (this._provisioningRetryBooted) return;
    if (!this._isControlPlane()) return;
    // Belt-and-braces: even on the control plane, only proceed if the
    // Subscription entity is actually installed (i.e. apps/control is in).
    if (!this.getRef("Subscription")) return;

    let runProvisioningRetrySweep;
    try {
      const modPath = path.join(
        this.pathRoot,
        'apps/control/modules/subscriptions/provisioning.js'
      );
      ({ runProvisioningRetrySweep } = await import(`file://${modPath}`));
    } catch (e) {
      console.warn(`[resumeProvisioningRetry] module not available: ${e.message}`);
      return;
    }

    try {
      const out = await runProvisioningRetrySweep();
      if (out.attempted > 0) {
        console.log(
          `✅ Provisioning resumed (${out.succeeded}/${out.attempted} ok, ${out.failed} fail)`
        );
      }
      this._provisioningRetryBooted = true;
    } catch (e) {
      console.warn(`[resumeProvisioningRetry] sweep failed: ${e.message}`);
    }
  }

  async rebuildVite() {
    console.log('*********Restarting Vite*********');
    await this.server.vite.restart();
    console.log('*********Reloading Browser*********');
    await this.server.vite.ws.send({ type: 'full-reload' });
  }

  async loadConfig(data = null) {
    if (data) {
      Object.assign(this, data);
    } else {
      const globalConfig = fileManage.getConfigFile("redis.config", "config", {})
      await this.loadConfig({...fileManage.getConfigFile('loopar.config', null, {}), ...globalConfig});
    }
  }

  async writeDefaultSSettings() {
    await fileManage.makeFolder("config");
    await fileManage.makeFolder("sites", this.tenantId, "config");

    if (!fileManage.existFileSync(path.join('sites',this.tenantId, "config", 'db.config.json'))) {
      await fileManage.setConfigFile('db.config', {});
    }

    if (!fileManage.existFileSync(path.join('sites', this.tenantId, 'config', 'loopar.config.json'))) {
      await fileManage.setConfigFile('loopar.config', {});
    }
  }

  async buildGlobalEnvironment() {
    GlobalEnvironment();

    global.Crypto = crypto;
    global.AJAX = 'POST';
    global.env = {};
    global.dayjs = dayjs;

    await this.writeDefaultSSettings();
    env.looparConfig = fileManage.getConfigFile('loopar.config', null, {});
  }

  async makeDefaultFolders() {
    await fileManage.makeFolder("apps");
    await fileManage.makeFolder("app", "auto");
    await fileManage.makeFolder('uploads', "public", "thumbnails");
    await fileManage.makeFolder('uploads', "private", "thumbnails");
  }
}