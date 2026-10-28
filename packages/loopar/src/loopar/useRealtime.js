import { LoopSocket } from "@services/realtime/LoopSocket";
import { useEffect, useRef } from "react";

/**
 * Subscribes to a realtime event. `event` is `room:action` or a bare action
 * (room `__global__`). The handler is read through a ref, so an inline
 * function does not re-subscribe (leave + join) on every render.
 */
export function useRealtime(event, handler, { ignoreSelf = false } = {}) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabled = !!handler;

  useEffect(() => {
    if (!event || !enabled) return;

    const [room, action] = event.includes(":")
      ? event.split(":")
      : ["__global__", event];

    let socket = null;
    let released = false;

    const listener = (payload) => {
      if (ignoreSelf && payload?.user === window.__user__) return;
      handlerRef.current?.(payload);
    };

    LoopSocket.onReady((s) => {
      if (released) return;
      socket = s;
      LoopSocket.join(room);
      s.on(action, listener);
    });

    return () => {
      released = true;
      if (socket) {
        socket.off(action, listener);
        LoopSocket.leave(room);
      }
    };
  }, [event, enabled, ignoreSelf]);
}
