package com.cuemark.tracker;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

public class ProgressWidgetProvider extends AppWidgetProvider {
    public static void updateAll(Context context, int total, int completed, int inProgress) {
        android.content.SharedPreferences prefs = context.getSharedPreferences("cuemark_widget", Context.MODE_PRIVATE);
        prefs.edit().putInt("total", total).putInt("completed", completed).putInt("inProgress", inProgress).apply();
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, ProgressWidgetProvider.class);
        updateWidgets(context, manager, manager.getAppWidgetIds(component));
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        updateWidgets(context, manager, ids);
    }

    private static void updateWidgets(Context context, AppWidgetManager manager, int[] ids) {
        android.content.SharedPreferences prefs = context.getSharedPreferences("cuemark_widget", Context.MODE_PRIVATE);
        int total = prefs.getInt("total", 0);
        int completed = prefs.getInt("completed", 0);
        int inProgress = prefs.getInt("inProgress", 0);

        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent pending = launch == null ? null : PendingIntent.getActivity(
            context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        for (int id : ids) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_progress);
            views.setTextViewText(R.id.widget_total, String.valueOf(total));
            views.setTextViewText(R.id.widget_completed, String.valueOf(completed));
            views.setTextViewText(R.id.widget_in_progress, String.valueOf(inProgress));
            if (pending != null) views.setOnClickPendingIntent(R.id.widget_root, pending);
            manager.updateAppWidget(id, views);
        }
    }
}
