'use strict'

import { BaseController, loopar, PermissionManager, Op } from 'loopar';
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

/** Upper bound of documents listed at once in a module with submodules. */
const GROUPED_PAGE_SIZE = 500;

export default class ModuleController extends BaseController {
  /** The module "view" is a list of its documents (cards). */
  async actionView() {
    this.entry = "list";
    // The module comes from the route (`/desk/<Module>`); its page state from
    // the URL: `?type=Entity&name=user&page=2` (document/list-state.js).
    const moduleName = this.name || "core";

    // Submodules are sections of this page: their documents are listed with
    // the module's own, grouped by the client (GridView, `__GROUPS__`).
    // The column arrives with the app update: until then there are none.
    const submodules = await loopar.db.qx().schema.hasColumn("Module", "parent_module")
      ? await loopar.db.getAll("Module", ["name", "description", "icon"], { parent_module: moduleName })
      : [];
    const grouped = submodules.length > 0;
    const inModule = grouped ? { module: { [Op.in]: [moduleName, ...submodules.map(m => m.name)] } } : { module: moduleName };

    // Types present in the module, with how many documents of each (the tabs' counters).
    const types = (await Promise.all(
      getTypes().map(async t => {
        const count = await loopar.db.count(t.name, inModule);
        return count > 0 ? { ...t, count } : null;
      })
    )).filter(Boolean);

    const type = ((!types.some(t => t.name == this.type)) ? (types.find(t => t.name == "Entity") || types[0])?.name : this.type) || "Entity";

    const queryData = loopar.getQ(this.document, { exclude: ["type", "module"] });

    await loopar.getDocument("Module", moduleName);

    // Always the full payload (never data-only): `?type=` swaps the listed
    // entity, so the cached meta of the previous type would not fit.
    // Grouped pages are not paginated: a page break would split the sections.
    const list = await loopar.getList(type, {
      q: queryData,
      filters: inModule,
      page: grouped ? 1 : loopar.getPage(this.document),
      pageSize: grouped ? GROUPED_PAGE_SIZE : undefined,
    });

    const moduleOf = grouped
      ? Object.fromEntries((await loopar.db.getAll(type, ["name", "module"], inModule)).map(r => [r.name, r.module]))
      : {};

    const before = list.rows.length;
    list.rows = await Promise.all(list.rows.filter(row => {
      return PermissionManager.can(row.name, "view") || PermissionManager.can(row.name, "list")
    }).map(async row => {
      const ref = loopar.getRef(row.name);
      return {
        ...row,
        ...(grouped ? { module: moduleOf[row.name] ?? row.module } : {}),
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

    list.Entity.name = "Module"

    // The module being shown, for the AppBar title (Entity is always "Module").
    // getAll, not getRow: getRow resets the shared pagination state.
    const [moduleRow = null] = moduleName
      ? await loopar.db.getAll("Module", ["name", "description", "icon", "app_name"], { name: moduleName })
      : [];

    // The module's own documents first (untitled), then one section per submodule.
    const groups = grouped ? {
      field: "module",
      groups: [
        { value: moduleName, title: "" },
        ...submodules.map(m => ({ value: m.name, title: m.description || m.name, icon: m.icon || null })),
      ],
    } : null;

    return this.render(list, {
      __TYPES__: types,
      __TYPE__: type,
      __MODULE__: moduleRow || null,
      __GROUPS__: groups,
      title: moduleRow?.description || moduleRow?.name || list.title,
      key: `${list.Entity.name}:${list.Entity.id}`}
    );
  }
}