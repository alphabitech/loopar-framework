import { io } from "socket.io-client";

/**
 * Stub socket — returned when io() construction fails. Implements just
 * enough of the socket.io-client API surface (on/off/emit/connected) that
 * callers don't crash. All event subscriptions are silent no-ops.
 */
function makeStubSocket() {
  return {
    connected: false,
    on: () => {},
    once: () => {},
    off: () => {},
    emit: () => {},
    disconnect: () => {},
  };
}

class _LoopSocket {
  constructor() {
    this._socket = null;
    this._siteName = null;
    // room → number of subscribers. The server keeps ONE membership per
    // socket, so the room is joined on the first subscriber and left only
    // when the last one goes (a single `leave` used to drop every listener).
    this._rooms = new Map();
  }

  onReady(callback) {
    if (this._socket?.connected) {
      callback(this._socket);
    } else if (this._socket) {
      this._socket.once("connect", () => callback(this._socket));
    } else {
      this._queue = this._queue || [];
      this._queue.push(callback);
    }
  }

  /**
   * Connects to the given site (or returns an existing connection).
   * Identity is derived server-side from the JWT cookie — the client does
   * @param {string} siteName  Site name (namespace)
   * @returns {import("socket.io-client").Socket}
   */
  connect(siteName) {
    if (this._socket && this._siteName === siteName) {
      return this._socket;
    }

    if (this._socket) {
      this._socket.disconnect();
      this._socket = null;
    }

    this._siteName = siteName;

    try {
      const url = window.location.origin;

      this._socket = io(`${url}/${siteName}`, {
        path: "/ws/socket.io",
        transports: ["websocket", "polling"],
        withCredentials: true,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
      });

      this._socket.on("connect", () => {
        console.log(`[LoopSocket] connected  site=${siteName}  id=${this._socket.id}`);
        // Rooms live on the server-side socket: a reconnect starts empty.
        // Join every room still subscribed (covers the first connect too).
        if (this._rooms.size) this._socket.emit("join", [...this._rooms.keys()]);
        (this._queue || []).forEach(cb => cb(this._socket));
        this._queue = [];
      });

      this._socket.on("disconnect", (reason) => {
        console.log(`[LoopSocket] disconnected  reason=${reason}`);
      });

      this._socket.on("connect_error", (err) => {
        console.warn("[LoopSocket] connection error:", err.message);
      });
    } catch (err) {
      console.error("[LoopSocket] failed to initialize socket:", err);
      this._socket = makeStubSocket();
    }

    return this._socket;
  }

  get() {
    return this._socket;
  }

  /**
   * Joins the socket to one or more rooms.
   * @param {string|string[]} channels
   */
  join(channels) {
    const fresh = [];
    for (const ch of [].concat(channels)) {
      const n = this._rooms.get(ch) || 0;
      this._rooms.set(ch, n + 1);
      if (n === 0) fresh.push(ch);
    }
    // While disconnected the "connect" handler joins them all.
    if (fresh.length && this._socket?.connected) this._socket.emit("join", fresh);
  }

  /** Releases one subscription per channel; the room is left with its last subscriber. */
  leave(channels) {
    const gone = [];
    for (const ch of [].concat(channels)) {
      const n = this._rooms.get(ch) || 0;
      if (n <= 1) {
        if (n === 1) gone.push(ch);
        this._rooms.delete(ch);
      } else {
        this._rooms.set(ch, n - 1);
      }
    }
    if (gone.length && this._socket?.connected) this._socket.emit("leave", gone);
  }

  disconnect() {
    this._socket?.disconnect();
    this._socket = null;
    this._siteName = null;
  }
}

// One instance per page even if the bundler loads this module twice (an
// aliased and a relative import resolved to two URLs → two sockets).
export const LoopSocket = (globalThis.__LOOPAR_SOCKET__ ??= new _LoopSocket());