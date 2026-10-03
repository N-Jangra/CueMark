package com.cuemark.tracker;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Clears only the Android WebView HTTP/resource cache. It does not clear
// localStorage, app data, backups, or the user's saved folder permission.
@CapacitorPlugin(name = "CacheManager")
public class CacheManagerPlugin extends Plugin {
    @PluginMethod
    public void clearWebViewCache(PluginCall call) {
        try {
            getBridge().getWebView().clearCache(true);
            call.resolve();
        } catch (Exception e) {
            // WebView cache clearing is best-effort. Cache Storage and the
            // thumbnail data kept in app state must remain usable even when
            // Android has no WebView cache directory to clear.
            call.resolve();
        }
    }
}
