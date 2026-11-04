// core/lib/FileSessionStore.js
import { Store } from 'express-session';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class FileSessionStore extends Store {
  constructor(options = {}) {
    super(options);
    this.sessionsDir = options.path || './sessions';
    this.ttl = options.ttl || 86400;
    
    if (!existsSync(this.sessionsDir)) {
      fs.mkdir(this.sessionsDir, { recursive: true }).catch(console.error);
    }
    
    if (options.reapInterval !== -1) {
      this.reapInterval = setInterval(
        () => this.reap(),
        (options.reapInterval || 3600) * 1000
      );
    }
  }
  
  #getFilePath(sid) {
    return path.join(this.sessionsDir, `${sid}.json`);
  }
  
  async get(sid, callback) {
    try {
      const filePath = this.#getFilePath(sid);
      const data = await fs.readFile(filePath, 'utf8');
      const session = JSON.parse(data);
      
      if (session.cookie?.expires) {
        const expires = new Date(session.cookie.expires);
        if (expires < new Date()) {
          await this.destroy(sid);
          return callback(null, null);
        }
      }
      
      callback(null, session);
    } catch (err) {
      callback(null, null);
      /* if (err.code === 'ENOENT') {
        callback(null, null);
      } else {
        callback(err);
      } */
    }
  }
  
  async set(sid, session, callback) {
    try {
      const filePath = this.#getFilePath(sid);
      await fs.writeFile(filePath, JSON.stringify(session), 'utf8');
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }
  
  async destroy(sid, callback) {
    try {
      const filePath = this.#getFilePath(sid);
      await fs.unlink(filePath);
      callback?.(null);
    } catch (err) {
      if (err.code === 'ENOENT') {
        callback?.(null);
      } else {
        callback?.(err);
      }
    }
  }
  
  async touch(sid, session, callback) {
    try {
      const filePath = this.#getFilePath(sid);
      await fs.access(filePath);
      
      if (session.cookie) {
        session.cookie.expires = new Date(Date.now() + this.ttl * 1000);
      }
      
      await fs.writeFile(filePath, JSON.stringify(session), 'utf8');
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }
  
  async reap() {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const now = new Date();
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        try {
          const filePath = path.join(this.sessionsDir, file);
          const data = await fs.readFile(filePath, 'utf8');
          const session = JSON.parse(data);
          
          if (session.cookie?.expires) {
            const expires = new Date(session.cookie.expires);
            if (expires < now) {
              await fs.unlink(filePath);
            }
          }
        } catch (err) {
        }
      }
    } catch (err) {
      console.error('err cleaning sessions:', err);
    }
  }
  
  async all(callback) {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const sessions = {};
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        try {
          const sid = file.replace('.json', '');
          const filePath = path.join(this.sessionsDir, file);
          const data = await fs.readFile(filePath, 'utf8');
          sessions[sid] = JSON.parse(data);
        } catch (err) {
        }
      }
      
      callback?.(null, sessions);
    } catch (err) {
      callback?.(err);
    }
  }
  
  async length(callback) {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const count = files.filter(f => f.endsWith('.json')).length;
      callback?.(null, count);
    } catch (err) {
      callback?.(err);
    }
  }
  
  async clear(callback) {
    try {
      const files = await fs.readdir(this.sessionsDir);
      
      await Promise.all(
        files
          .filter(f => f.endsWith('.json'))
          .map(f => fs.unlink(path.join(this.sessionsDir, f)))
      );
      
      callback?.(null);
    } catch (err) {
      callback?.(err);
    }
  }
  
  close() {
    if (this.reapInterval) {
      clearInterval(this.reapInterval);
    }
  }
}