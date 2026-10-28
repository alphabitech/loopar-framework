
'use strict';

import { BaseDocument, loopar, getRequest } from 'loopar';
import mime from "mime-types";
import fs from "fs";
import path from 'pathe';
import crypto from 'crypto';

export default class FileManager extends BaseDocument {
  #reqUploadFile = null;
  #remoteImport = null;
  #route = null;
  #owner = null;
  constructor(props) {
    super(props);
  }

  get reqUploadFile() {
    return this.#reqUploadFile;
  }

  /**
   * The record a private file belongs to: `{ entity, name, field }`. Written
   * to the file's sidecar; only users who may view that record can download
   * the file (see the private asset handler in the router middleware).
   */
  set owner(owner) {
    this.#owner = owner?.entity ? { entity: owner.entity, name: owner.name ?? null, field: owner.field ?? null } : null;
  }

  get owner() {
    return this.#owner;
  }

  get isPrivate() {
    return this.visible === 'private';
  }

  get remoteImport() {
    return this.#remoteImport;
  }

  /**
   * "Web"-origin counterpart of `reqUploadFile`: takes a URL instead of a
   * multer buffer. `name` must match the doc reference so the post-save
   * patcher can rewrite it (derived from the URL if missing). `mode`:
   * "reference" (record the URL as-is) or "download" (fetch bytes via the
   * active driver).
   */
  set remoteImport({ url, name, mode } = {}) {
    if (!url) {
      this.#remoteImport = null;
      return;
    }

    let derivedName = name;
    if (!derivedName) {
      try {
        const u = new URL(url);
        const last = u.pathname.split('/').filter(Boolean).pop();
        derivedName = last ? decodeURIComponent(last) : `import_${Date.now()}`;
      } catch {
        derivedName = `import_${Date.now()}`;
      }
    }
    derivedName = this.normalizeFileName(derivedName);

    this.route = derivedName;
    if (this.__IS_NEW__) {
      this.name = derivedName;
      this.created_at = new Date();
    }
    this.extention = (derivedName.split('.').pop() || '').toLowerCase();

    this.#remoteImport = { url, derivedName, mode: mode || 'reference' };
  }

  normalizeFileName(name = '') {
    if (typeof name !== 'string') return '';

    let normalized = name;

    // Repair mojibake with a single latin1 -> utf8 decode.
    if (/[\u0080-\u009f]/.test(normalized)) {
      normalized = Buffer.from(normalized, 'latin1').toString('utf8');
    }

    return normalized
      .normalize('NFKC')
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  set reqUploadFile(file) {
    if (file?.originalname) {
      // Multer can provide latin1-encoded names for utf-8 filenames.
      file.originalname = this.normalizeFileName(Buffer.from(file.originalname, 'latin1').toString('utf8'));
    }

    this.size = file.size;
    this.type = this.getFileType(file);
    this.extention = file.originalname.split('.').pop();
    this.route = file.originalname || '';

    if (this.__IS_NEW__) {
      this.name = file.originalname;
      this.created_at = new Date();
    }

    this.#reqUploadFile = file;
  }

  getFileType(file) {
    file ??= this.reqUploadFile;
    if(!file) return 'file';

    const ext = (file.originalname || file.name).split('.').pop().toLowerCase();
    const mimeType = mime?.lookup(ext)?.split('/')?.shift();
    return mimeType ?? 'file';
  }

  get pathBase() {
    if (this.app && this.app.length > 0) {
      return loopar.makePath(loopar.pathRoot, 'apps', this.app, 'uploads', this.visible || "public");
    } else {
      return loopar.makePath(loopar.tenantPath, 'uploads', this.visible || "public");
    }
  }

  getStatFile() {
    const pathBase = this.pathBase;
    const filePath = path.join(pathBase, this.name);
    try {
      return fs.statSync(filePath);
    } catch (e) {
      return null;
    }
  }

  getFile() {
    const pathBase = this.pathBase;
    const filePath = path.join(pathBase, this.name);
    try {
      return fs.readFileSync(filePath);
    } catch (e) {
      return null;
    }
  }

  metaFile() {
    return loopar.utils.isJSON(this.file_ref) ? JSON.parse(this.file_ref)[0] : {};
  }

  get thumbnailPath() {
    return loopar.makePath(this.pathBase, "thumbnails");
  }

  get filePath() {
    return loopar.makePath(this.pathBase, this.name);
  }

  get route() {
    return this.#route ?? this.metaFile().src ?? '';
  }

  set route(route) {
    this.#route = route;
  }

  get isLocal() {
    return typeof this.route === 'string' && this.route.startsWith('/');
  }

  get isRemote() {
    return !this.isLocal;
  }

  async save() {
    const file = this.reqUploadFile;
    const remote = this.#remoteImport;

    // Filesystem-only entity: nothing to persist without a binary or a
    // remote import.
    if (!file && !remote) {
      return this;
    }

    let uploadName;
    if (file) {
      uploadName = this.normalizeFileName(
        Buffer.from(file.originalname || file.name || '', 'latin1').toString('utf8')
      );
      if (!uploadName) uploadName = this.name;
      this.#reqUploadFile.originalname = uploadName;
    } else {
      uploadName = remote.derivedName || this.name;
    }

    // Private files get an unguessable, unique stored name: two people
    // sending "resume.pdf" must never share (or reuse) one file.
    if (this.isPrivate) {
      if (remote) loopar.throw('Private files can only be uploaded, not imported from a URL.');
      uploadName = `${crypto.randomBytes(12).toString('hex')}-${uploadName}`;
      this.#reqUploadFile.originalname = uploadName;
      this.name = uploadName;
    }

    // Collision check: same name + same app = reuse the existing asset
    // (mirrors are per-app because `getAssetPath` is app-scoped). If the
    // mirror exists, rehydrate from it and return before any driver call;
    // re-uploads under the same name are a no-op (content-based
    // replacement is a future task).
    const existing = this.isPrivate ? null : this.#readMirror(uploadName);
    if (existing) {
      this.name = uploadName;
      this.__DOCUMENT_NAME__ = uploadName;
      this.size = existing.size;
      this.type = existing.type;
      this.extention = existing.extention || (uploadName.split('.').pop() || '').toLowerCase();
      this.storage_driver = existing.storage_driver;
      this.external_id = existing.external_id;
      this.external_url = existing.external_url;
      this.file_ref = JSON.stringify([{
        name: uploadName,
        type: existing.type,
        size: existing.size,
        src: existing.src,
        previewSrc: existing.previewSrc,
      }]);
      this.route = uploadName;
      return this;
    }

    // Persist — three paths, same result shape: binary upload → driver
    // `.upload()`, download import → driver `.importFromUrl()`, reference
    // import → no driver (just record the URL, tagged
    // `storage_driver = "reference"`).
    const isReference = !!remote && remote.mode === 'reference';

    let result;
    let driverName;
    if (isReference) {
      driverName = 'reference';
      result = {
        externalId: remote.url,
        src: remote.url,
        bytes: null,
        storedName: uploadName,
      };
    } else {
      // Private files stay on this server's disk: a CDN driver would hand
      // out a public URL, and the private handler checks access per request.
      const driver = this.isPrivate ? loopar.storage.for('local') : loopar.storage.active;
      driverName = driver.name;
      result = file
        ? await driver.upload({
            buffer: file.buffer,
            originalName: uploadName,
            app: this.app,
            visibility: this.visible || 'public',
            contentType: file.mimetype || mime?.lookup(uploadName) || null,
          })
        : await driver.importFromUrl({
            url: remote.url,
            app: this.app,
            visibility: this.visible || 'public',
          });
    }

    // LocalDriver may rename on content collision; other drivers keep the name.
    if (result.storedName !== uploadName) {
      uploadName = result.storedName;
      this.name = uploadName;
      this.__DOCUMENT_NAME__ = uploadName;
    }

    // Record metadata on the document.
    this.size = result.bytes;
    this.extention = (uploadName.split('.').pop() || '').toLowerCase();
    this.type = this.getFileType({ originalname: uploadName });
    this.storage_driver = driverName;
    this.external_id = result.externalId || null;
    // external_url: absolute URL for assets outside our /assets; null for local.
    this.external_url = (driverName === 'local') ? null : result.src;
    // previewSrc: computed by the driver; a referenced external URL can't
    // be transformed, so it previews as itself.
    const previewSrc = isReference
      ? result.src
      : loopar.storage.for(driverName).deliveryUrl({
          src: result.src,
          externalId: result.externalId,
          transform: {
            width: 200,
            height: 200,
            fit: 'cover',
            format: 'auto',
            quality: 'auto',
          },
        });

    this.file_ref = JSON.stringify([{
      name: uploadName,
      type: this.type,
      size: result.bytes,
      src: result.src,
      previewSrc,
    }]);
    this.route = uploadName;

    // No DB write — the mirror sidecar is the asset's source of truth.
    await this.#writeMirror({ src: result.src, previewSrc, bytes: result.bytes });
    return this;
  }

  /**
   * Write the asset's `{name}.meta.json` mirror — what the asset
   * middleware uses to resolve remote assets without touching the DB.
   * Writes to a .tmp file and renames so reads never see half-written JSON.
   */
  async #writeMirror({ src, previewSrc, bytes }) {
    if (!this.name) return;

    const dir = loopar.getAssetPath({
      app: this.app,
      visibility: this.visible || 'public',
    });
    await fs.promises.mkdir(dir, { recursive: true });

    const mirrorPath = path.join(dir, `${this.name}.meta.json`);
    const data = {
      version: 1,
      name: this.name,
      type: this.type || null,
      extention: this.extention || null,
      size: bytes ?? this.size ?? null,
      storage_driver: this.storage_driver || 'local',
      external_id: this.external_id || null,
      external_url: this.external_url || null,
      src,
      previewSrc,
      app: this.app || null,
      visibility: this.visible || 'public',
      ...(this.#owner ? { owner: this.#owner } : {}),
      updated_at: new Date().toISOString(),
    };

    const tmpPath = `${mirrorPath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, mirrorPath);
  }

  async #deleteMirror() {
    if (!this.name) return;
    const dir = loopar.getAssetPath({
      app: this.app,
      visibility: this.visible || 'public',
    });
    const mirrorPath = path.join(dir, `${this.name}.meta.json`);
    try {
      await fs.promises.unlink(mirrorPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn('[File Manager] mirror unlink failed:', err?.message || err);
      }
    }
  }

  async delete() {
    // No DB row: if the entity wasn't hydrated, resolve the owning
    // driver from the mirror.
    if (!this.storage_driver) {
      const mirror = this.#readMirror();
      if (mirror) {
        this.storage_driver = mirror.storage_driver;
        this.external_id = mirror.external_id;
      }
    }

    // Physical deletion goes through the owning driver (`local` as safe
    // default). A `reference` asset has no bytes of ours — skip it.
    const driverName = this.storage_driver || 'local';
    if (driverName !== 'reference') {
      const driver = loopar.storage.for(driverName);
      await driver.delete({
        externalId: this.external_id,
        storedName: this.name,
        app: this.app,
        visibility: this.visible || 'public',
      });
    }

    // Drop the mirror so the read path stops resolving this asset.
    await this.#deleteMirror();
  }

  async loadDiskFiles(rows = []) {
    // Installed apps only — same source `getAssetRoots()` uses, so the
    // listing matches what the server can actually serve (a non-installed
    // app's assets would 404).
    const apps = Object.keys(loopar.installedApps || {});

    const loadFiles = (source = "uploads", app) => {
      // Accept relative (`apps/x/uploads`) and absolute (tenant) sources —
      // joining an absolute path onto pathRoot used to produce a bogus
      // path that hid the whole tenant subtree.
      const sourcePath = path.isAbsolute(source)
        ? source
        : path.join(loopar.pathRoot, source);


      if (fs.existsSync(sourcePath)) {
        const filesPath = path.join(sourcePath, this.visible || "public");
        if (fs.existsSync(filesPath)) {
          const diskFiles = fs.readdirSync(filesPath);

          // Binaries in this dir, to detect mirrors with an adjacent binary.
          const binarySet = new Set(diskFiles.filter(f => !f.endsWith('.meta.json')));

          diskFiles.forEach(file => {
            const fullPath = path.join(filesPath, file);

            // Mirrors are listed only when there's no adjacent binary
            // (remote-driver assets); otherwise the binary branch below
            // handles the file.
            if (file.endsWith('.meta.json')) {
              const baseName = file.slice(0, -'.meta.json'.length);
              
              if (binarySet.has(baseName)) return;
              if (rows.findIndex(r => r.name === baseName) !== -1) return;

              try {
                const raw = fs.readFileSync(fullPath, 'utf8');
                const meta = JSON.parse(raw);
                rows.push({
                  name: baseName,
                  created_at: meta.updated_at ? new Date(meta.updated_at) : null,
                  extention: meta.extention || baseName.split('.').pop(),
                  size: meta.size,
                  type: meta.type,
                  app: app,
                  storage_driver: meta.storage_driver,
                  external_id: meta.external_id,
                  external_url: meta.external_url,
                  // src/previewSrc let getMappedFiles render the preview directly.
                  src: meta.src,
                  previewSrc: meta.previewSrc,
                });
              } catch {}
              
              return;
            }

            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) return;
            if (rows.findIndex(r => r.name === file) !== -1) return;

            rows.push({
              name: file,
              created_at: stat.birthtime,
              extention: file.split('.').pop(),
              size: stat.size,
              app: app
            });
          });
        }
      }
    }

    if (this.app) {
      loadFiles(`apps/${this.app}/uploads`, this.app);
    } else {
      for (const app of apps) {
        loadFiles(`apps/${app}/uploads`, app);
      }

      loadFiles("uploads");
      loadFiles(path.join(loopar.tenantPath, "uploads"));
    }

    return rows;
  }

  loadFile(file) {
    // 1. Local binary (LocalDriver assets).
    file ??= this.getStatFile();

    if (file) {
      this.file_ref = JSON.stringify([{
        name: this.name,
        type: this.getFileType({name: this.name, ...file}),
        size: this.size,
        src: `/assets/${this.visible || "public"}/${this.name}`
      }]);

      this.size = file.size;
      this.created_at = file.birthtime;
      this.extention = this.name.split('.').pop();
      this.type = this.getFileType({name: this.name, ...file});
      this.name = this.name;

      return true;
    }

    // 2. No binary — fall back to the mirror (remote-driver assets leave
    //    only `{name}.meta.json` on disk).
    const mirror = this.#readMirror();
    if (mirror) {
      this.file_ref = JSON.stringify([{
        name: this.name,
        type: mirror.type || this.getFileType({name: this.name}),
        size: mirror.size,
        src: mirror.src,
        previewSrc: mirror.previewSrc,
      }]);

      this.size = mirror.size;
      this.extention = mirror.extention || this.name.split('.').pop();
      this.type = mirror.type || this.getFileType({name: this.name});
      this.storage_driver = mirror.storage_driver;
      this.external_id = mirror.external_id;
      this.external_url = mirror.external_url;

      return true;
    }

    return false;
  }

  /**
   * Read a mirror from disk (own name by default; `save()` passes one
   * for its collision check). Returns parsed metadata or null.
   */
  #readMirror(name = this.name) {
    if (!name) return null;
    const dir = loopar.getAssetPath({
      app: this.app,
      visibility: this.visible || 'public',
    });
    const mirrorPath = path.join(dir, `${name}.meta.json`);
    try {
      const raw = fs.readFileSync(mirrorPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async getList({ fields = null, filters = {}, q = null, rowsOnly = false } = {}) {
    q ??= {};
    q.visible = this.visible || "public";
    const workspace = loopar.workspace;

    const explicitPage = parseInt(this.page);
    const pagination = {
      page: explicitPage > 0 ? explicitPage : loopar.getPage(this.__ENTITY__.name),
      pageSize: parseInt(this.pageSize || 10),
      totalPages: 1,
      totalRecords: 0,
      sortBy: "id",
      sortOrder: "asc",
      __ENTITY__: this.__ENTITY__.name
    };

    const listFields = this.getFieldListNames();
    const allRows = await this.loadDiskFiles([]);
    
    const nameFilter = (this.name || "").toLowerCase();
    const extFilter = (this.extention || "").toLowerCase();
    const filtered = allRows.filter(row =>
      (row.name || "").toLowerCase().includes(nameFilter) &&
      (row.extention || "").toLowerCase().includes(extFilter)
    );

    pagination.totalRecords = filtered.length;
    pagination.totalPages = Math.max(1, Math.ceil(filtered.length / pagination.pageSize));

    if (pagination.page > pagination.totalPages) pagination.page = pagination.totalPages;

    const startIndex = (pagination.page - 1) * pagination.pageSize;
    const rows = filtered.slice(startIndex, startIndex + pagination.pageSize);

    const selfPagination = JSON.parse(JSON.stringify(pagination));

    return Object.assign((rowsOnly ? {} : await this.__meta__()), {
      labels: this.getFieldListLabels(),
      fields: listFields,
      rows: rows,
      pagination: selfPagination,
      q
    });
  }

  async getPrivateFile() {
    return null;
  }
}