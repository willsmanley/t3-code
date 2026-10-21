/**
 * The preload script sets window.desktopBridge via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

// Preview builds can opt into the project-tree sidebar without changing a
// user's persisted web preference. Desktop already enables it independently.
export const forceLegacySidebar = import.meta.env.VITE_T3CODE_LEGACY_SIDEBAR === "1";
