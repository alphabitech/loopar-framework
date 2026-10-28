import { createContext, useContext, useEffect, useRef, useState } from "react";
import { LoopSocket } from "@services/realtime/LoopSocket";

const RealtimeContext = createContext(null);

export function RealtimeProvider({ siteName, children }) {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    if (!siteName) return;

    const socket = LoopSocket.connect(siteName);
    socketRef.current = socket;

    socket.on("connect",    () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    if (socket.connected) setConnected(true);

    return () => {
      socket.off("connect");
      socket.off("disconnect");
    };
  }, [siteName]);

  return (
    <RealtimeContext.Provider value={{ connected, socket: socketRef }}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtimeContext() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error("useRealtimeContext must be used inside <RealtimeProvider>");
  return ctx;
}