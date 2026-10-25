/** package.json version, injected at build time (vite.config.ts). */
declare const __APP_VERSION__: string

/**
 * WiFi radios through meshmash-bridge (build with VITE_BRIDGE=1). When false, the feature is
 * left out of the build: its code is loaded only inside `if (__BRIDGE__)` branches.
 */
declare const __BRIDGE__: boolean
