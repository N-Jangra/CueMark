package com.cuemark.tracker;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "Notifications",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class NotificationPlugin extends Plugin {
    public static final String CHANNEL_ID = "cuemark-reminders";
    public static final String ACTION_NOTIFICATION = "com.cuemark.tracker.NOTIFICATION_ACTION";
    private static Intent pendingAction;

    public static void captureIntent(Intent intent) {
        if (intent != null && ACTION_NOTIFICATION.equals(intent.getAction())) pendingAction = intent;
    }

    @Override
    public void load() {
        super.load();
        createChannel(getContext());
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) {
            resolvePermission(call, true);
            return;
        }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED) {
            resolvePermission(call, true);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        resolvePermission(call, canNotify());
    }

    @PluginMethod
    public void hasPermission(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < 33
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        resolvePermission(call, granted);
    }

    @PluginMethod
    public void getPendingAction(PluginCall call) {
        Intent intent = pendingAction;
        pendingAction = null;
        JSObject result = new JSObject();
        if (intent != null) {
            result.put("action", intent.getStringExtra("notificationAction"));
            result.put("itemId", intent.getStringExtra("itemId"));
            result.put("actionUrl", intent.getStringExtra("actionUrl"));
        }
        call.resolve(result);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        String title = call.getString("title", "CueMark");
        String body = call.getString("body", "You have a CueMark reminder.");
        String itemId = call.getString("itemId", "");
        String actionUrl = call.getString("actionUrl", "");
        int snoozeMinutes = call.getInt("snoozeMinutes", 60);
        int id = call.getInt("id", (int) (System.currentTimeMillis() & 0x7fffffff));
        if (!canNotify()) {
            call.reject("Notification permission is not granted");
            return;
        }

        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        Intent launchIntent = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
        PendingIntent pendingIntent = launchIntent == null ? null : PendingIntent.getActivity(
            getContext(), id, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), CHANNEL_ID)
            .setSmallIcon(com.cuemark.tracker.R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true);
        if (pendingIntent != null) builder.setContentIntent(pendingIntent);
        addActions(getContext(), builder, id, itemId, actionUrl, title, body, snoozeMinutes);
        manager.notify(id, builder.build());
        call.resolve();
    }

    @PluginMethod
    public void schedule(PluginCall call) {
        long at = call.getLong("at", 0L);
        String title = call.getString("title", "CueMark");
        String body = call.getString("body", "You have a CueMark reminder.");
        String itemId = call.getString("itemId", "");
        String actionUrl = call.getString("actionUrl", "");
        int snoozeMinutes = call.getInt("snoozeMinutes", 60);
        int id = call.getInt("id", (int) (System.currentTimeMillis() & 0x7fffffff));
        if (at <= System.currentTimeMillis()) {
            call.reject("Notification time must be in the future");
            return;
        }
        if (!canNotify()) {
            call.reject("Notification permission is not granted");
            return;
        }

        Intent intent = new Intent(getContext(), NotificationReceiver.class)
            .putExtra("id", id).putExtra("title", title).putExtra("body", body)
            .putExtra("itemId", itemId).putExtra("actionUrl", actionUrl).putExtra("snoozeMinutes", snoozeMinutes);
        PendingIntent pending = PendingIntent.getBroadcast(
            getContext(), id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        AlarmManager alarm = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (Build.VERSION.SDK_INT >= 23) {
            alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        } else {
            alarm.set(AlarmManager.RTC_WAKEUP, at, pending);
        }
        call.resolve();
    }

    private boolean canNotify() {
        return Build.VERSION.SDK_INT < 33
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    public static void addActions(Context context, NotificationCompat.Builder builder, int id, String itemId, String actionUrl, String title, String body, int snoozeMinutes) {
        if (itemId != null && !itemId.isEmpty()) {
            Intent watched = new Intent(context, MainActivity.class).setAction(ACTION_NOTIFICATION)
                .putExtra("notificationAction", "mark_watched").putExtra("itemId", itemId).putExtra("actionUrl", actionUrl);
            builder.addAction(0, "Mark watched", PendingIntent.getActivity(context, id + 1, watched, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            Intent open = new Intent(context, MainActivity.class).setAction(ACTION_NOTIFICATION)
                .putExtra("notificationAction", "open").putExtra("itemId", itemId).putExtra("actionUrl", actionUrl);
            builder.addAction(0, "Open item", PendingIntent.getActivity(context, id + 2, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        Intent snooze = new Intent(context, NotificationReceiver.class)
            .putExtra("action", "snooze").putExtra("id", id).putExtra("title", title).putExtra("body", body)
            .putExtra("itemId", itemId).putExtra("actionUrl", actionUrl).putExtra("snoozeMinutes", snoozeMinutes);
        builder.addAction(0, "Snooze 1h", PendingIntent.getBroadcast(context, id + 3, snooze, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    }

    private void resolvePermission(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    public static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "CueMark reminders", NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Progress and watchlist reminders from CueMark");
        manager.createNotificationChannel(channel);
    }
}
