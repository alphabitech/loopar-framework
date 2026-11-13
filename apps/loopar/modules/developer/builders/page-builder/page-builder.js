
'use strict';

import { Entity } from '../../../../../loopar/modules/core/entities/entity/entity.js';
import { migrateDocument } from 'loopar/core/global/element-migration.js';
import { compactPageSeo } from 'loopar/core/global/page-seo.js';

export default class PageBuilder extends Entity {
  constructor(props) {
    super(props);
  }

  /**
   * Head tags are page settings (the `seo` field), never elements of the
   * canvas: seo nodes that still arrive in a design — an app file written
   * before the SEO tab — are folded into `seo` on the way in.
   */
  async save() {
    const structure = typeof this.doc_structure === "string" ? this.doc_structure : JSON.stringify(this.doc_structure || []);
    if (structure.includes('"element":"seo"')) {
      const migrated = migrateDocument({ doc_structure: structure, translations: this.translations, seo: this.seo });
      if (migrated.changed) {
        this.doc_structure = migrated.doc_structure;
        if (migrated.seo !== undefined) this.seo = migrated.seo;
        if (migrated.translations !== undefined) this.translations = migrated.translations;
      }
    }
    this.seo = compactPageSeo(this.seo);

    return super.save(...arguments);
  }
}
