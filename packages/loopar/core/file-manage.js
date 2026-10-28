import path from "pathe";
import { loopar } from "./loopar.js";
import fs, { access, existsSync } from 'fs';
import { pathToFileURL } from 'url';

class FileManage {
  async makeFile(destiny, name, content, ext = 'js', replace = false) {
    const filePath = loopar.makePath(loopar.pathRoot, destiny, this.fileName(name, ext));
    const folderPath = path.dirname(filePath);

    try {
      if (existsSync(filePath) && ['jsx', 'tsx', 'js', 'sqlite'].includes(ext) && !replace) return;
    } catch (e) {
      return;
    }

    await new Promise((resolve, reject) => {
      fs.mkdir(folderPath, { recursive: true }, (err) => {
        if (err) return reject(new Error(err));
        resolve();
      });
    });
    
    return new Promise((resolve, reject) => {
      fs.writeFile(filePath, content, (err) => {
        if (err) return reject(new Error(err));
        resolve();
      });
    });
  }

  async existFile(fileRoute) {
    const isRelative = fileRoute.startsWith("./");
    return new Promise(resolve => {
      access(isRelative ? path.resolve(fileRoute) : path.resolve(loopar.makePath(loopar.pathRoot, fileRoute)), (err) => {
        return resolve(!err);
      });
    });
  }

  existFileSync(fileRoute) {
    const isRelative = fileRoute.startsWith('.');
    const route = isRelative ? path.resolve(fileRoute) : path.resolve(loopar.makePath(loopar.pathRoot, fileRoute));

    try {
      fs.accessSync(route);
      return true;
    } catch (e) {
      return false;
    }
  }

  async existFolder(folderRoute) {
    return new Promise(resolve => {
      access(path.resolve(loopar.makePath(loopar.pathRoot, folderRoute)), (err) => {
        return resolve(!err);
      });
    });
  }

  /*async importFile(fileRoute, onError = null) {
     const isRelative = fileRoute.startsWith('.');
     isRelative && console.log("Test is relative", path.resolve(fileRoute))
     const route = isRelative ? fileRoute : loopar.makePath(loopar.pathRoot, fileRoute);

     try {
        if (!this.existFileSync(fileRoute)) {
           onError ? onError(`File ${fileRoute} not found`) : loopar.throw(`File ${fileRoute} not found`);
        } else {
           return await import(route);
        }
     } catch (e) {
        throw new Error(e + ` ${fileRoute}`);
     }

  }*/

  async importClass(fileRote, onError) {
    const isRelative = fileRote.startsWith('.');
    const moduleName = fileRote.split('/').pop().split('.')[0];

    try {
      let normalizedPath = path.resolve(isRelative ? fileRote : path.join(loopar.pathRoot, fileRote));
      normalizedPath = pathToFileURL(normalizedPath).href;
 
      const Class = await import(normalizedPath);
      return Class.default;
    } catch (e) {
      if (e.code == 'ERR_MODULE_NOT_FOUND') {
        const moduleNotFoundName = e.message.split('imported from')[0]?.split('/').pop().split('.')[0];

        if (moduleNotFoundName == moduleName) {
          if (typeof onError === 'function' && !onError.prototype) {
            return onError(`File ${fileRote} not found`);
          } else if (typeof onError != "object") {
            return onError;
          } else {
            return loopar.throw({
              code: 404,
              message: `File ${fileRote} not found`
            });
          }
        } else {
          return loopar.throw({
            code: 500,
            message: `${e} ${fileRote},\n\nPlease check your dependencies and imports in the file ${fileRote}`
          });
        }
      }

      return loopar.throw({
        code: 500,
        message: `${e} ${fileRote}`
      });
    }
  }

  async makeFolder(...args) {
    const folderPath =  loopar.makePath(loopar.pathRoot, ...args);

    return new Promise(resolve => {
      fs.mkdir(folderPath, { recursive: true }, (err) => {
        if (err) throw new Error(err);
        resolve();
      });
    });
  }

  async deleteFile(destiny, name, ext = 'js') {
    const filePath = loopar.makePath(loopar.pathRoot, destiny, this.fileName(name, ext));
    if (!existsSync(filePath)) return false;
    await fs.promises.unlink(filePath);
    return true;
  }

  async deleteFolder(destiny, name) {
    const folderPath = loopar.makePath(loopar.pathRoot, destiny, name);

    return new Promise(resolve => {
      fs.rmdir(folderPath, { recursive: true }, (err) => {
        if (err) throw new Error(err);
        resolve();
      });
    });
  }

  async makeClass(destiny, name, { IMPORTS = {}, EXTENDS = null } = {}, importer_type = '', ext = 'js') {
    const _EXTENDS = EXTENDS ? ` extends ${EXTENDS}` : '';
    const CONSTRUCTOR = EXTENDS ? `super(props);` : 'Object.assign(this, props);';

    name = this.className(name);
    const fileName = this.fileName(name);

    const o = importer_type === 'default' ? '' : '{';
    const c = importer_type === 'default' ? '' : '}';

    const classContent = `
'use strict';

${Object.entries(IMPORTS).map(([ref, file]) => `import ${o}${ref}${c} from '${file}';`).join('\n')}

export default class ${name}${_EXTENDS} {
    constructor(props){
        ${CONSTRUCTOR}
    }
}`;

    return await this.makeFile(destiny, name, classContent, ext);
  }
  
toKebabCase(str) {
  return inflection.dasherize(
    inflection.underscore(str.replace(/\s+/g, ''))
  );
}

  fileName(name, ext = 'js') {
    return `${loopar.utils.lowercase(loopar.utils.decamelize(name, { separator: '-' }))}.${ext}`;
  }

  folderName(name) {
    return loopar.utils.lowercase(loopar.utils.decamelize(name, { separator: '-' }));
  }

  className(name) {
    return name.replace(/\s/g, '');
  }

  getConfigFile(fileName, _path = null) {
    const pathFile = this.fileName((`./${_path || path.join("sites", loopar.tenantId, "config")}/${fileName}`), 'json');
    try {
      const data = fs.readFileSync(path.resolve(loopar.pathRoot, pathFile), 'utf8');
      return loopar.utils.isJSON(data) ? JSON.parse(data) : {};
    } catch (error) {
      return {};
    }
  }

  async setConfigFile(fileName, data, p = null) {
    const dirPath = p || path.join("sites", loopar.tenantId, `config`);

    await this.makeFile(dirPath, fileName, JSON.stringify(data, null, 2), 'json');
  }

  getAppData(appName) {
    return this.getConfigFile("installer", loopar.makePath('apps', appName), null);
  }
}

export const fileManage = new FileManage();