// Preload installs desktopBridge before web code runs, so module-load detection is reliable.
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

// Preview builds can opt into the project-tree sidebar without changing a
// user's persisted web preference. Desktop already enables it independently.
export const forceLegacySidebar = import.meta.env.VITE_T3CODE_LEGACY_SIDEBAR === "1";
