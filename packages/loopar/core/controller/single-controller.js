'use strict'

import { __ } from '../global/i18n.js';
import BaseController from './base-controller.js';
import { loopar } from "loopar";
import {parseDocStructure} from '../document/tools.js';
import { resolvePageSeo, pageSeoTags } from '../global/page-seo.js';
import { translationLayer } from '../global/i18n-content.js';
import { requestLanguage, siteDefaultLanguage } from '../server/i18n.js';
import { siteOrigin } from '../global/seo.js';

/**
 * Head tags of a website page, in the language of the request: its `seo`
 * settings with the page's translations applied.
 */
function pageSeo(page, req) {
  const language = requestLanguage();
  const layer = page?.translations && language !== siteDefaultLanguage()
    ? translationLayer(page.translations, language)
    : null;
  const seo = resolvePageSeo(page?.seo, layer);
  return { seo, tags: pageSeoTags(seo, { origin: siteOrigin(req) }) };
}

export default class SingleController extends BaseController {
  static inheritedActions = ['view', 'update', 'print'];
  
  constructor(props) {
    super(props);

    this.action === 'list' && this.redirect('update');
  }

  async getParent(){
    return await loopar.db.getValue('Menu Item', "page", {page: this.document});
  }

  async sendAction(action) {
    await this.beforeAction();
    const selfAction = `${loopar.utils.Capitalize(action)}`;

    if (typeof this[`publicAction${selfAction}`] == 'function' && !this.isRevokedPublicAction(action)) {
      return await this[`publicAction${selfAction}`]();
    }else if(typeof this[`action${selfAction}`] == 'function'){
      return await this[`action${selfAction}`]();
    }else{
      return await this.sendDocument(action);
    }
  }

  /* async actionView() {
    return await this.sendDocument();
  } */

  async publicActionCollection(action = this.document, data = {}) {
    const webApp = loopar.webApp || { menu_items: [] };
    const { collection, detailSlug } = this.query;

    if (!collection || !detailSlug) {
      return loopar.throw({
        code: 404,
        message: "Collection viewer requires ?collection= and ?detailSlug=.",
      });
    }

    const requestContext = {
      slug: detailSlug,
      app: webApp?.name || null,
      query: this.query || {},
    };

    const doc_structure = await parseDocStructure(JSON.stringify([
      {
        element: "collection_view",
        data: {
          options: collection,
          // Comments only where the entity enables them (posts, projects…).
          enable_comments: loopar.utils.trueToBinary(loopar.getRef(collection)?.enable_comments),
        },
      },
    ]), true, this.document, requestContext);

    if (!requestContext._anyDetailMatched) {
      return loopar.throw({
        code: 404,
        message: `Page not found: ${collection}/${detailSlug}`,
      });
    }

    const preloadedItem = doc_structure?.[0]?.data?.preloaded?.item;

    this.client = 'page';
    return await this.render({
      Entity: {
        name: "Page Viewer",
        doc_structure: JSON.stringify(doc_structure),
        
      },
      activeParentMenu: await this.getParent(),
      __DOCUMENT_TITLE__: preloadedItem?.title || detailSlug,
      exactTitle: preloadedItem?.title || null,
      __DETAIL_SLUG__: detailSlug,
      ...data,
    });
  }

  /**
   * Resolves the menu item a URL segment names, the same way the router
   * resolves the first segment (`toEntityKey`: case, spaces, `-` and `_`
   * don't matter), so `/doc/getting-started` and `/Doc/Getting Started`
   * land on the same item. Descendants of the current page's root menu
   * win over items elsewhere in the tree, so a repeated link (two
   * "Overview" under different parents) resolves inside its own section.
   */
  #resolveMenu(menuItems, action) {
    const key = loopar.utils.toEntityKey;
    const target = key(action);
    if (!target) return null;

    const matches = (item, field) => item[field] && key(item[field]) === target;
    const find = (items) =>
      items.find(item => matches(item, "link")) || items.find(item => matches(item, "page"));

    const roots = menuItems.filter(item => !item.parent_menu && key(item.page) === key(this.document));
    const descendants = [];
    const walk = (parentLink) => {
      for (const item of menuItems) {
        if (item.parent_menu && key(item.parent_menu) === key(parentLink) && !descendants.includes(item)) {
          descendants.push(item);
          walk(item.link);
        }
      }
    };
    roots.forEach(root => walk(root.link));

    return find(descendants) || find(menuItems) || null;
  }

  async sendDocument(action=this.document, data={}) {
    const webApp = loopar.webApp || { menu_items: [] };
    const menu = this.#resolveMenu(webApp.menu_items || [], action);

    let pageDocName;
    let detailSlug = null;

    if (menu) {
      pageDocName = menu.page;
    } else if (action === this.document) {
      pageDocName = this.document;
    } else {
      pageDocName = this.document;
      detailSlug = action;
    }

    const requestContext = {
      slug: detailSlug,
      app: webApp?.name || null,
      query: this.query || {},
    };

    const document = await loopar.getDocument(pageDocName, undefined, null, { requestContext });

    if (detailSlug && !requestContext._anyDetailMatched) {
      return loopar.throw({
        code: 404,
        message: `Page not found: ${this.document}/${detailSlug}`,
      });
    }

    const pageRef = loopar.getRef(document.__ENTITY__?.name) || {};
    const head = pageSeo(document.__ENTITY__, this.req);

    return await this.render({
      Entity: {
        name: document.__ENTITY__?.name,
        background_image: document.__ENTITY__?.background_image,
        doc_structure: document.__ENTITY__?.doc_structure || "[{}]",
        enable_history: loopar.utils.trueToBinary(pageRef.enable_history),
        enable_comments: loopar.utils.trueToBinary(pageRef.enable_comments),
        require_login_to_comment: loopar.utils.trueToBinary(pageRef.require_login_to_comment),
      },
      activeParentMenu: await this.getParent(),
      __DOCUMENT_TITLE__: requestContext._detailTitle || (menu?.link ? __(menu.link) : this.document),
      exactTitle: requestContext._detailTitle || head.seo.title || null,
      // A record's detail has its own title: the page's social title would name the listing.
      seo_tags: requestContext._detailTitle ? head.tags.filter(t => t.attrs.property !== "og:title") : head.tags,
      ...(detailSlug? { __DETAIL_SLUG__: detailSlug } : {}),
      ...data,
    });
  }
}