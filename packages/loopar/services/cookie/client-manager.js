export default class ClientManager {
  constructor(props) {
    this.updater = props.updater;
  }

  get(name) {
    const cookies = this.getAll();

    const value = cookies[name];

    if (value === 'undefined') {
      return undefined;
    }

    if (value === 'true') {
      return true;
    }

    if (value === 'false') {
      return false;
    }

    if(value === 'null') return null

    return value;
  }

  getAll() {
    const pairs = document.cookie.split(';');
    const cookies = {};

    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i].split('=');
      cookies[(pair[0] + '').trim()] = decodeURIComponent(pair[1]);
    }

    return cookies;
  }

  set(name, value = '', days = 30) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));

    // Cookies hold strings only: objects go as JSON (callers parse them) and every
    // value is URI-encoded so `;`, `=` or spaces can't break the cookie. `get`
    // already decodes. Before this, objects were written as "[object Object]".
    const serialized = value !== null && typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

    const chunks = [
      `${name}=${encodeURIComponent(serialized)}`,
      `expires=${date.toUTCString()}`,
      'path=/'
    ].join('; ');

    document.cookie = chunks;
    this.updater && this.updater(date);
  }
}