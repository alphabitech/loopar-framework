import { loopar } from "loopar";
import { fileManage } from "../file-manage.js";

export class ActionScanner {
  static async getActions(documentName, root, publicOnly = false) {
    try {
      const ControllerClass = await fileManage.importClass(
        loopar.makePath(root, `${documentName}Controller.js`)
      );
  
      if (!ControllerClass) return [];
  
      const candidates = loopar.extractControllerMethods(ControllerClass, null, documentName);
  
      if (candidates.length === 0) return [];
  
      const clean = action => action.replace(/^(public)?action/i, '');
  
      if (publicOnly) {
        const publicArr = (ControllerClass.publicActions ?? []).map(a => a.toLowerCase());
        const revoked = (ControllerClass.revokedPublicActions ?? []).map(a => String(a).toLowerCase());
        return candidates
          .filter(action =>
            action.startsWith('public') || publicArr.includes(action.toLowerCase())
          )
          .map(clean)
          .filter(action => !revoked.includes(action.toLowerCase()));
      }
  
      const enabled = ControllerClass.actionsEnabled;
      if (Array.isArray(enabled) && enabled.length > 0) {
        const enabledSet = new Set(enabled);
        return candidates
          .filter(action => enabledSet.has(clean(action)))
          .map(clean);
      }
  
      return candidates.map(clean);
    } catch {
      return [];
    }
  }

  static async getAllActions(publicOnly = false) {
    const map  = [];
    const refs = loopar.getRefs() ?? {};

    await Promise.all(
      Object.entries(refs).map(async ([name, ref]) => {
        const actions = await ActionScanner.getActions(ref.__NAME__, ref.__ROOT__, publicOnly);
        if (actions.length > 0) {
          for (const action of actions) {
            map.push({ document: ref.__NAME__, app: ref.__APP__, action });
          }
        }
      })
    );

    return map;
  }

  static async getPublicActions() {
    return ActionScanner.getAllActions(true);
  }

  /** App that owns `documentName` (refs are keyed by normalized entity key). */
  static getApp(documentName) {
    const ref = loopar.getRef(documentName);
    return ref?.__APP__ ?? null;
  }
}