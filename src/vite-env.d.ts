/// <reference types="vite/client" />

// Build-time constant injected by vite.config.ts (`define` block). Holds
// a short git SHA + ISO date stamp, or "dev" if git wasn't available.
declare const __BUILD_ID__: string;
