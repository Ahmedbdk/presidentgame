export function isDebugToolsEnabled(configuredValue) {
  return configuredValue === "true";
}

const viteEnvironment = import.meta.env || {};

// This controls UI visibility only. The backend independently requires
// ENABLE_DEBUG_TOOLS=true before it will execute any debug event.
export const DEBUG_TOOLS_ENABLED = isDebugToolsEnabled(
  viteEnvironment.VITE_ENABLE_DEBUG_TOOLS
);
