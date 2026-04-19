/**
 * Widget Module: Realtime Resolver.
 *
 * Maps a backend-resolved realtime vendor to:
 *   - the asset path of the matching widget driver module
 *   - the global window key the driver registers itself under
 *
 * The widget runtime calls `resolveDriverDescriptor(vendor)` and then
 * lazy-loads the script. Each driver implements the SAME hook contract:
 *
 *   create(ctx, resolved, hooks) → {
 *     connect, disconnect,
 *     subscribeConversation, unsubscribeConversation,
 *     sendTyping,
 *     getCapabilities, hasCapability, getDriverName,
 *   }
 *
 * Adding a new realtime vendor in the future = add one entry here +
 * one driver file. The runtime stays vendor-agnostic.
 */
(function () {
  'use strict';

  var DRIVERS = {
    centrifugo: {
      asset: 'runtime-rt-centrifugo.js',
      globalKey: '__gs_mod_rt_centrifugo',
    },
    supabase: {
      asset: 'runtime-rt-supabase.js',
      globalKey: '__gs_mod_rt_supabase',
    },
    // 'polling_builtin' and 'disabled' are NOT drivers — they are handled
    // directly by the runtime's transport layer (polling fallback / no-op).
  };

  function resolveDriverDescriptor(vendor) {
    if (!vendor) return null;
    return DRIVERS[vendor] || null;
  }

  function isDriverVendor(vendor) {
    return !!DRIVERS[vendor];
  }

  window.__gs_mod_rt_resolver = {
    resolveDriverDescriptor: resolveDriverDescriptor,
    isDriverVendor: isDriverVendor,
  };
})();
