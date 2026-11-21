import { createContext, useContext, useEffect } from "react";

/**
 * A fixed panel of its own (the designer's) docked on the right of the desk
 * document: while one is mounted DeskUI keeps room for it and hides the
 * record panel, which would sit under it.
 */
export const SidePanelContext = createContext(null);

/** Call from a component that docks a fixed right panel, while it is mounted. */
export function useReserveSidePanel() {
  const reserve = useContext(SidePanelContext);
  useEffect(() => {
    if (!reserve) return;
    reserve(1);
    return () => reserve(-1);
  }, [reserve]);
}
