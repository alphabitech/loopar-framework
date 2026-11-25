
'use strict';

import {BaseDocument, loopar, deleteRecords} from 'loopar';

export default class Role extends BaseDocument {
    constructor(props){
        super(props);
    }

    /**
     * System roles are seeded by installers; deleting one by hand would just
     * get it re-seeded. The exception is uninstalling the app that owns it.
     */
    async delete(...args) {
        const uninstallingOwner = this.app && loopar.installingApp === this.app;
        if (loopar.utils.trueValue(this.is_system_role) && !uninstallingOwner) {
            loopar.throw(`Role "${this.name}" is a system role and cannot be deleted. Disable it instead.`);
        }
        // Its grants go with it: a role created later with the same name must
        // not inherit them. Through each Permission's model, so its hooks run
        // (PermissionManager drops its cache). Assigned users hold the delete
        // back (User Role → Role).
        return await loopar.db.withTransaction(async () => {
            await deleteRecords('Permission', { relation: 'Role', relation_name: this.name }, { sofDelete: args[0]?.sofDelete });
            return await super.delete(...args);
        });
    }
}