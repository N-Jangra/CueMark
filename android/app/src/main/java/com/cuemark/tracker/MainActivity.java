package com.cuemark.tracker;

import android.os.Bundle;
import android.content.Intent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppIconPlugin.class);
        registerPlugin(BackupFolderPlugin.class);
        registerPlugin(CacheManagerPlugin.class);
        registerPlugin(EncryptedStorePlugin.class);
        registerPlugin(BackupSchedulerPlugin.class);
        registerPlugin(NotificationPlugin.class);
        registerPlugin(ShareIntentPlugin.class);
        registerPlugin(BiometricPlugin.class);
        registerPlugin(WidgetPlugin.class);
        super.onCreate(savedInstanceState);
        NotificationPlugin.captureIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NotificationPlugin.captureIntent(intent);
    }
}
