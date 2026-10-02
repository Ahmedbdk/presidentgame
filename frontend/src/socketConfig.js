export function resolveSocketUrl({ configuredUrl }) {
  if (typeof configuredUrl === "string" && configuredUrl.trim()) {
    return configuredUrl.trim();
  }

  // Both deployment and Vite development use same-origin Socket.IO by
  // default. Vite proxies /socket.io to the local backend during development.
  return null;
}

const viteEnvironment = import.meta.env || {};

export const SOCKET_URL = resolveSocketUrl({
  configuredUrl: viteEnvironment.VITE_SOCKET_URL,
});
