package com.cuemark.tracker;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.app.AlarmManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;

public class NotificationReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if ("snooze".equals(intent.getStringExtra("action"))) {
            long at = System.currentTimeMillis() + (long) intent.getIntExtra("snoozeMinutes", 60) * 60_000L;
            Intent reminder = new Intent(context, NotificationReceiver.class)
                .putExtra("id", intent.getIntExtra("id", 1)).putExtra("title", intent.getStringExtra("title"))
                .putExtra("body", intent.getStringExtra("body")).putExtra("itemId", intent.getStringExtra("itemId"))
                .putExtra("actionUrl", intent.getStringExtra("actionUrl"))
                .putExtra("snoozeMinutes", intent.getIntExtra("snoozeMinutes", 60));
            PendingIntent pendingReminder = PendingIntent.getBroadcast(context, intent.getIntExtra("id", 1), reminder, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            AlarmManager alarm = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (Build.VERSION.SDK_INT >= 23) alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pendingReminder);
            else alarm.set(AlarmManager.RTC_WAKEUP, at, pendingReminder);
            return;
        }
        NotificationPlugin.createChannel(context);
        int id = intent.getIntExtra("id", (int) (System.currentTimeMillis() & 0x7fffffff));
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        String itemId = intent.getStringExtra("itemId");
        String actionUrl = intent.getStringExtra("actionUrl");
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent pending = launch == null ? null : PendingIntent.getActivity(
            context, id, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, NotificationPlugin.CHANNEL_ID)
            .setSmallIcon(com.cuemark.tracker.R.mipmap.ic_launcher)
            .setContentTitle(title == null ? "CueMark" : title)
            .setContentText(body == null ? "You have a reminder." : body)
            .setAutoCancel(true);
        if (pending != null) builder.setContentIntent(pending);
        NotificationPlugin.addActions(context, builder, id, itemId, actionUrl, title, body, intent.getIntExtra("snoozeMinutes", 60));
        ((NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE)).notify(id, builder.build());
    }
}
