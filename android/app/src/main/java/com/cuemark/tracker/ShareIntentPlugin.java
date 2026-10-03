package com.cuemark.tracker;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {
    @PluginMethod
    public void getInitialShare(PluginCall call) {
        Intent intent = getActivity().getIntent();
        JSObject result = new JSObject();
        String text = extractText(intent);
        if (text != null && !text.isEmpty()) {
            result.put("text", text);
            result.put("type", intent.getType() == null ? "" : intent.getType());
            call.resolve(result);
        } else {
            result.put("text", "");
            result.put("type", "");
            call.resolve(result);
        }
    }

    private String extractText(Intent intent) {
        if (intent == null) return "";
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text != null && !text.isEmpty()) return text;
        Uri data = intent.getData();
        return data == null ? "" : data.toString();
    }
}
