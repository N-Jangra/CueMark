package com.cuemark.tracker;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Widget")
public class WidgetPlugin extends Plugin {
    @PluginMethod
    public void update(PluginCall call) {
        int total = call.getInt("total", 0);
        int completed = call.getInt("completed", 0);
        int inProgress = call.getInt("inProgress", 0);
        ProgressWidgetProvider.updateAll(getContext(), total, completed, inProgress);
        call.resolve();
    }
}
