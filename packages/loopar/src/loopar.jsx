import { createRouter } from "@@tools/router/router";
import { readNavTrace } from "@@tools/router/nav-trace";
import * as dateUtils from "@global/date-utils";
import * as Helpers from "@global/helper";
import scriptManager from "@@tools/script-manager";
import { elementsDict, AIPrompt, AIStructureSchema, sanitizeAIStructure } from "@global/element-definition";
import Emitter from '@services/emitter/emitter';
import animation from "./loopar/animation.js";
import { ClientDatabase } from "./loopar/ClientDatabase.js";
export { useRealtime } from "./loopar/useRealtime.js";

class Loopar {
  scriptManager = scriptManager;
  currentPageName = "";
  sidebarOption = "preview";
  Components = {};
  #loadedMeta = {};
  generatedColors = {};

  /** The router instance — reachable directly as `loopar.router`. */
  router = createRouter();

  constructor() {
    this.utils = Helpers;
    this.cookie = Helpers.cookie;
    this.dateUtils = dateUtils;
    this.db = new ClientDatabase(this);
    this.animation = animation;

    // UI adapter: the router is UI-agnostic; Loopar plugs its own effects.
    this.router.bindUI({
      freeze: (state) => this.freeze(state),
      notify: (payload) => this.notify(payload),
      refresh: () => this.refresh(),
      error: (err) => this.throw(err),
    });
  }

  call(Document, action, options) { return this.router.call(Document, action, options); }
  fetchDocument(path, options) { return this.router.fetchDocument(path, options); }
  navigate(to, options) { return this.router.navigate(to, options); }
  get workspace() { return this.router.workspace; }
  get user() { return this.router.user; }
  isLoggedIn() { return this.router.isLoggedIn(); }

  /** Port pass-throughs for <RouterBridge/> and <WorkspaceProvider/>. */
  _bindRouter(binding) { this.router._bindRouter(binding); }
  _unbindRouter() { this.router._unbindRouter(); }
  _bindWorkspace(workspace) { this.router._bindWorkspace(workspace); }
  _bindSession(user) { this.router._bindSession(user); }

  dialog(dialog, callback) {
    const content = dialog.content || dialog.message;
    dialog.id ??= typeof content === "string" ? dialog.content : dialog.title;
    dialog.open = dialog.open !== false;
    dialog.ok ??= callback;
    this.emit('dialog', dialog);
  }

  prompt(dialog) {
    dialog.id = "test-dialog";
    dialog.open = true;
    dialog.type = "prompt";
    dialog.content = <></>
    this.emit('dialog', dialog);
  }

  confirm(message, callback, onCancel) {
    let settled = false;
    const settle = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      fn?.(...args);
    };

    const ok = settle(callback);
    const cancel = settle(onCancel);

    this.emit('dialog', {
      icon: null,
      type: "confirm",
      title: "Confirm",
      content: message,
      ok,
      cancel,
      onClose: () => setTimeout(cancel, 0),
      ...(typeof message == 'object' ? message : {})
    });
  }

  alert(message, callback) {
    this.dialog({
      type: "alert",
      title: "Loopar",
      content: message,
      callback: callback,
    });
  }

  closeDialog(id) {
    this.handleOpenCloseDialog(id, false);
  }

  handleOpenCloseDialog(id, open) {
    this.emit('handle-open-close-dialog', id, open);
  }

  throw(error, m, throwError = true) {
    this.emit('freeze', false);

    let normalized;
    if (typeof error === "object" && error !== null) {
      normalized = error;
    } else if (typeof m === "string") {
      normalized = { title: error, message: m };
    } else {
      normalized = { title: "Error", message: error };
    }

    const { type = "error", title = "Error", message } = normalized;

    this.emit('dialog', {
      ...normalized,
      type,
      title,
      message,
    });

    if (throwError) {
      throw new Error(message);
    } else {
      console.error("LOOPAR: uncaughtException", message);
    }
  }

  notify() {
    const { message, type = "success", title } = loopar.utils.args(["message", "type", "title"], arguments);
    // Default title follows the type — a hardcoded "success" mislabeled error toasts.
    const resolvedTitle = title || (type.charAt(0).toUpperCase() + type.slice(1));
    this.emit('notify', { message, type, title: resolvedTitle });
  }

  emit(event, data) {
    Emitter.emit(event, data);
  }

  bgColor(name, alpha = 0.8) {
    name ??= "Loopar"
    function hashCode(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
      }
      return hash;
    }

    function stringToColor(str) {
      const hash = hashCode(str);
      let color = "#";

      for (let i = 0; i < 3; i++) {
        const value = (hash >> (i * 8)) & 0xff;
        color += ("00" + value.toString(16)).substr(-2);
      }

      return color;
    }

    const getColorForWord = (word) => {
      if (!this.generatedColors[word]) {
        this.generatedColors[word] = stringToColor(word);
      }
      return this.generatedColors[word];
    };

    function mixColors(colors) {
      let avgRed = 0,
        avgGreen = 0,
        avgBlue = 0;

      colors.forEach((color) => {
        avgRed += parseInt(color.slice(1, 3), 16);
        avgGreen += parseInt(color.slice(3, 5), 16);
        avgBlue += parseInt(color.slice(5, 7), 16);
      });

      avgRed = Math.round(avgRed / colors.length);
      avgGreen = Math.round(avgGreen / colors.length);
      avgBlue = Math.round(avgBlue / colors.length);

      const minColorValue = 50;
      const maxColorValue = 205;

      avgRed = Math.min(Math.max(avgRed, minColorValue), maxColorValue);
      avgGreen = Math.min(Math.max(avgGreen, minColorValue), maxColorValue);
      avgBlue = Math.min(Math.max(avgBlue, minColorValue), maxColorValue);

      return `rgba(${avgRed}, ${avgGreen}, ${avgBlue}, ${alpha})`;
    }
    const words = name.split(/\s+/);
    const colors = words.map(getColorForWord);
    return mixColors(colors);
  }

  reload() {
    this.#loadedMeta = {};
    this.emit('refresh', { force: true });
  }

  refresh() {
    this.emit('refresh');
  }

  /**
   * Debug: last navigations / redirects / document swaps with their call
   * site. Run `loopar.navTrace()` in the console right after an unexpected
   * redirect (before reloading) and share the table.
   */
  navTrace() {
    const trace = readNavTrace();
    console.table(trace.map(({ stack, ...row }) => row));
    return trace;
  }

  freeze(freeze = true) {
    Emitter.emit('freeze', freeze);
  }

  async getMeta(Document, action, query = {}) {
    if (!this.#loadedMeta[Document + action]) {
      const loadMeta = async () => {
        return new Promise((resolve) => {
          this.call(Document, action, {
            query,
            success: (data) => {
              this.#loadedMeta[Document + action] = data;
              resolve();
            },
          });
        });
      };

      await loadMeta();
    }

    return this.#loadedMeta[Document + action];
  }

  require(src, callback, options = { async: true }) {
    const loadScript = (currentSrc, currentCallback, currentOptions) =>
      this.scriptManager.loadScript(currentSrc, currentCallback, currentOptions);

    if (Array.isArray(src)) {
      return Promise.all(src.map((s) => loadScript(s, callback, options)));
    } else {
      return loadScript(src, callback, options);
    }
  }

  includeCSS(src, callback) {
    return this.scriptManager.loadStylesheet(src, { callback });
  }
}

const loopar = new Loopar();
export default loopar;
export { loopar, elementsDict, AIPrompt, AIStructureSchema, sanitizeAIStructure };
