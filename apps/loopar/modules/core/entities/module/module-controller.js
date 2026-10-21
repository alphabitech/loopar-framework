'use strict'

import { BaseController, loopar, PermissionManager } from 'loopar';
import { pluralize } from 'inflection';

const getTypes = () => Object.values(loopar.getTypes()).reduce((acc, type) => {
  acc.push({
    name: type.__NAME__,
    label: pluralize(type.__BUILD__ || type.__ENTITY__)
  });
  return acc;
}, []);

export default class ModuleController extends BaseController {
  /** The module "view" is a list of its documents (cards). */
  

  async privateActionTest(){}
  async actionView() {
    this.entry = "list";
    const data = this.data || {};
    const q = data.q || data;

    const types = (await Promise.all(
      getTypes().map(async t => 
        await loopar.db.count(t.name, { module: this.name || q.module || "core" }) > 0 ? t : null
      )
    )).filter(Boolean);

    const type = ((!types.some(t => t.name == this.type)) ? (types.find(t => t.name == "Entity") || types[0])?.name : this.type) || "Entity";
    const eType = `${type}DocumentQ`;
    const eModule = `${eType}Module`;

    if (!data.q) loopar.session.set(eModule, this.name);

    const queryData = {
      ...(data.q || loopar.session.get(eType) || {}),
      module: loopar.session.get(eModule),
    };

    if (queryData.module) await loopar.getDocument("Module", queryData.module);

    loopar.session.set(eType, queryData);
    // Same key getList() reads (loopar.getPage: workspace + entity): a raw
    // `${type}page` key was never read back, so every page came back as 1.
    loopar.setPage(type, this.data.page || 1);

    const list = await loopar.getList(type, { q: queryData, rowsOnly: this.preloaded === 'true'});

    const before = list.rows.length;
    list.rows = list.rows.filter(row => {
      return PermissionManager.can(row.name, "view") || PermissionManager.can(row.name, "list")
    }).map(row => {
      const ref = loopar.getRef(row.name);
      return {
        ...row,
        is_single: ref?.is_single || 0,
        type: ref?.__ENTITY__ || "Entity",
      };
    });

    // Cards are filtered by permission after pagination: keep the counter
    // honest for what this user actually sees.
    if (list.pagination && before !== list.rows.length) {
      const hidden = before - list.rows.length;
      list.pagination.totalRecords = Math.max(0, (list.pagination.totalRecords ?? before) - hidden);
      list.pagination.totalPages = Math.max(1, Math.ceil(list.pagination.totalRecords / (list.pagination.pageSize || 10)));
    }

    if(this.preloaded == 'true') return {
      instance: this.getInstance(),
      rows: list.rows
    };

/*     list.Entity.name = "Module";
    list.__TYPES__ = types//.filter(t => list.rows.some(r => r.type == t.name))
    list.__TYPE__ = type;
    list.key = `${list.Entity.name}:${list.Entity.id}` */
    list.Entity.name = "Module"
    return this.render(list, {
      __TYPES__: types,
      __TYPE__: type,
      key: `${list.Entity.name}:${list.Entity.id}`}
    );
  }
}