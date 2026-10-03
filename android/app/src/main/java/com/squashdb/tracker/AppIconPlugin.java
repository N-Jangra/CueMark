package com.squashdb.tracker;

import android.content.ComponentName;
import android.content.pm.PackageManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Android bakes a launcher icon+label into each activity-alias at build time, so the
// app's home-screen look can only be switched live by enabling one pre-declared alias
// out of a fixed set and disabling the rest (see AndroidManifest.xml: Look_<key>).
// Each key already bakes in both an icon and a matching name, so there is no separate
// name axis to combine with.
@CapacitorPlugin(name = "AppIcon")
public class AppIconPlugin extends Plugin {

    // Must match the alias names in AndroidManifest.xml (Look_<key>)
    private static final String[] LOOK_KEYS = {
        "default",
        "fire",
        "pinklogo",
        "purple",
        "capacitor",
        "calculator",
        "freeotp",
        "termux",
        "controller",
        "gear"
    };

    // Must match the key of the alias with android:enabled="true" in AndroidManifest.xml
    private static final String DEFAULT_LOOK_KEY = "default";

    private String aliasName(String lookKey) {
        return "Look_" + lookKey;
    }

    private boolean isValidLookKey(String lookKey) {
        for (String key : LOOK_KEYS) {
            if (key.equals(lookKey)) return true;
        }
        return false;
    }

    @PluginMethod
    public void setLook(PluginCall call) {
        String lookKey = call.getString("look");

        if (lookKey == null || !isValidLookKey(lookKey)) {
            call.reject("Invalid or missing 'look' parameter");
            return;
        }

        PackageManager pm = getContext().getPackageManager();
        String packageName = getContext().getPackageName();

        for (String key : LOOK_KEYS) {
            String alias = aliasName(key);
            ComponentName component = new ComponentName(packageName, packageName + "." + alias);
            int newState = key.equals(lookKey)
                ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                : PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
            pm.setComponentEnabledSetting(component, newState, PackageManager.DONT_KILL_APP);
        }

        JSObject result = new JSObject();
        result.put("success", true);
        result.put("look", lookKey);
        call.resolve(result);
    }

    @PluginMethod
    public void getLook(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        String packageName = getContext().getPackageName();
        // Must match the alias enabled by default in AndroidManifest.xml (Look_default)
        String activeLook = DEFAULT_LOOK_KEY;

        for (String key : LOOK_KEYS) {
            String alias = aliasName(key);
            ComponentName component = new ComponentName(packageName, packageName + "." + alias);
            int state = pm.getComponentEnabledSetting(component);
            boolean enabled = state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                || (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && key.equals(DEFAULT_LOOK_KEY));
            if (enabled) {
                activeLook = key;
                break;
            }
        }

        JSObject result = new JSObject();
        result.put("look", activeLook);
        call.resolve(result);
    }
}
