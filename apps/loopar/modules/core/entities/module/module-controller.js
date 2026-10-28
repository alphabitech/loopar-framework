'use strict'

import { BaseController, loopar, PermissionManager } from 'loopar';
import { pluralize } from 'inflection';

const getTypes = () => Object.values(loopar.getTypes()).map(type => {
  const singular = type.__BUILD__ || type.__ENTITY__;
  return { name: type.__NAME__, singular, label: pluralize(singular) };
});

/** Records in an entity's own table, or null when it has none (single, virtual, pages, views…). */
const countRecords = async (ref) => {
  if (!ref || ref.is_single || ref.is_virtual) return null;
  try {
    return await loopar.db.count(ref.__NAME__, {});
  } catch {
    return null;
  }
};

export default class ModuleController extends BaseController {
  /** The module "view" is a list of its documents (cards). */
  

  async privateActionTest(){}
  async actionView() {
    this.entry = "list";
    // The module comes from the route (`/desk/<Module>`); its page state from
    // the URL: `?type=Entity&name=user&page=2` (document/list-state.js).
    const moduleName = this.name || "core";

    // Types present in the module, with how many documents of each (the tabs' counters).
    const types = (await Promise.all(
      getTypes().map(async t => {
        const count = await loopar.db.count(t.name, { module: moduleName });
        return count > 0 ? { ...t, count } : null;
      })
    )).filter(Boolean);

    const type = ((!types.some(t => t.name == this.type)) ? (types.find(t => t.name == "Entity") || types[0])?.name : this.type) || "Entity";

    const queryData = {
      ...loopar.getQ(this.document, { exclude: ["type"] }),
      module: moduleName,
    };

    await loopar.getDocument("Module", moduleName);

    // Always the full payload (never data-only): `?type=` swaps the listed
    // entity, so the cached meta of the previous type would not fit.
    const list = await loopar.getList(type, { q: queryData, page: loopar.getPage(this.document) });

    const before = list.rows.length;
    list.rows = await Promise.all(list.rows.filter(row => {
      return PermissionManager.can(row.name, "view") || PermissionManager.can(row.name, "list")
    }).map(async row => {
      const ref = loopar.getRef(row.name);
      return {
        ...row,
        is_single: ref?.is_single || 0,
        is_child: ref?.is_child || 0,
        is_virtual: ref?.is_virtual || 0,
        type: ref?.__ENTITY__ || "Entity",
        // Card subtitle; child rows only make sense inside their parent.
        __records__: ref?.is_child ? null : await countRecords(ref),
      };
    }));

    // Cards are filtered by permission after pagination: keep the counter
    // honest for what this user actually sees.
    if (list.pagination && before !== list.rows.length) {
      const hidden = before - list.rows.length;
      list.pagination.totalRecords = Math.max(0, (list.pagination.totalRecords ?? before) - hidden);
      list.pagination.totalPages = Math.max(1, Math.ceil(list.pagination.totalRecords / (list.pagination.pageSize || 10)));
    }

/*     list.Entity.name = "Module";
    list.__TYPES__ = types//.filter(t => list.rows.some(r => r.type == t.name))
    list.__TYPE__ = type;
    list.key = `${list.Entity.name}:${list.Entity.id}` */
    list.Entity.name = "Module"

    // The module being shown, for the AppBar title (Entity is always "Module").
    // getAll, not getRow: getRow resets the shared pagination state.
    const [moduleRow = null] = moduleName
      ? await loopar.db.getAll("Module", ["name", "description", "icon", "app_name"], { name: moduleName })
      : [];

    return this.render(list, {
      __TYPES__: types,
      __TYPE__: type,
      __MODULE__: moduleRow || null,
      title: moduleRow?.description || moduleRow?.name || list.title,
      key: `${list.Entity.name}:${list.Entity.id}`}
    );
  }
}