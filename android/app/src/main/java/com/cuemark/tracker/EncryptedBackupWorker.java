package com.cuemark.tracker;

import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Periodically copies the already encrypted local state into the chosen SAF folder. */
public class EncryptedBackupWorker extends Worker {
    public EncryptedBackupWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            Context context = getApplicationContext();
            String treeUriString = context.getSharedPreferences("cuemark_backup_location", Context.MODE_PRIVATE).getString("uri", null);
            String packedState = EncryptedStorePlugin.readPackedState(context);
            if (treeUriString == null || packedState == null || packedState.isEmpty()) return Result.success();

            Uri treeUri = Uri.parse(treeUriString);
            Uri root = DocumentsContract.buildDocumentUriUsingTree(treeUri, DocumentsContract.getTreeDocumentId(treeUri));
            String date = new SimpleDateFormat("yyyy-MM-dd_HH-mm", Locale.US).format(new Date());
            String fileName = "cuemark_background_" + date + ".sqdb";
            Uri target = DocumentsContract.createDocument(
                context.getContentResolver(), root, "application/octet-stream", fileName
            );
            if (target == null) return Result.retry();
            try (OutputStream output = context.getContentResolver().openOutputStream(target, "wt")) {
                if (output == null) return Result.retry();
                output.write(packedState.getBytes(StandardCharsets.UTF_8));
            }
            return Result.success();
        } catch (SecurityException e) {
            return Result.failure();
        } catch (Exception e) {
            return Result.retry();
        }
    }
}
