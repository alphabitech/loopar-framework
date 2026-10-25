import { loopar, BaseController, PermissionManager } from "loopar";

export default class DbController extends BaseController {
  static inheritedActions = ['view'];
  static freeActions = ["getList", "getAll"]

  async actionView() {
  }

  async actionGetList(){
    const { document } = this.query;
    const { options } = this.body || {};

    if(!PermissionManager.can(document, "list")){
      loopar.throw(`You do not have acces to ${document}.${this.action}`)
    }

   return await loopar.db.getList(document, options)
  }

  async actionGetDoc(){
    const { document, name } = this.query;
    const { data, options } = this.body || {};

    if(!PermissionManager.can(document, "view")){
      loopar.throw(`You do not have acces to ${document}.view`)
    }

   return await loopar.db.getDoc(document, name, data, options)
  }

  async actionCount(){
    const { document } = this.query;
    const { filter } = this.body || {};
    if(!PermissionManager.can(document, "list")){
      loopar.throw(`You do not have acces to count ${document}`)
    }

    // Wrapped: a bare `0` is falsy and the router turns it into `{}`.
    return { count: Number(await loopar.db.count(document, filter)) || 0 };
  }

  async actionGetAll(){
    const { document } = this.query;
    const { options } = this.body || {};

    if(!PermissionManager.can(document, "list")){
      loopar.throw(`You do not have acces to ${document}.${this.action}`)
    }

   return await loopar.db.getAll(document, options)
  }
}