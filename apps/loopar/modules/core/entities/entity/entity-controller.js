import { BaseController, loopar } from 'loopar';
import { pluralize } from 'inflection';

const getTypes = () => Object.values(loopar.getTypes()).reduce((acc, type) => {
  acc.push({
    name: type.__NAME__,
    label: pluralize(type.__BUILD__ || type.__ENTITY__)
  });
  return acc;
}, []);

export default class EntityController extends BaseController {
  constructor(props) {
    super(props);
  }

  async actionBulkDelete() {
    loopar.throw("You can't delete Entities in bulk");
  }

  async actionSetTailwind() {
    if (this.hasData()) {
      const { to_element, classes } = this.data;

      loopar.setTailwindTemp(to_element, decodeURIComponent(classes || ""));

      return this.success("Tailwind set successfully");
    } else {
      return this.error("No data provided");
    }
  }

  async actionList() {
    // Filters come from the URL query (document/list-state.js), empties already dropped.
    const data = loopar.getQ(this.document);

    const list = await loopar.getList(this.document, { data, q: (data && Object.keys(data).length > 0) ? data : null });

    const rows = list.rows.map(row => {
      const ref = loopar.getRef(row.name);
      return {
        ...row,
        is_single: ref?.is_single || 0,
        is_child: ref?.is_child || 0,
        type: ref?.__ENTITY__ || "Entity",
      };
    });

    if(this.preloaded == true) {
      return {
        instance: this.getInstance(),
        rows: rows,
        pagination: list.pagination,
        q: list.q || {},
      }
    }

    list.rows = rows;

    return await this.render(list);
  }

  async actionOrphanColumns(){
    return await loopar.db.getOrphanColumns(this.name);
  }

  async actionReleaseColumn()  { return await loopar.db.releaseOrphanColumn(this.name, this.column); }
  async actionDropColumn() { 
    return await loopar.db.dropOrphanColumn(this.name, this.column); 
  }
  async actionRestoreColumn()  { return await loopar.db.restoreOrphanColumn(this.name, this.column); }
}