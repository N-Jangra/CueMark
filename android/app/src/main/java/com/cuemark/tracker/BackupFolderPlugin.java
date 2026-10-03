package com.cuemark.tracker;

import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.database.Cursor;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.util.Base64;

import com.getcapacitor.JSArray;

// Lets the user pick a folder (via Android's Storage Access Framework tree picker)
// to store CueMark backups in, and persists access to it across app restarts so
// exports/imports never need to re-prompt once a folder has been chosen.
@CapacitorPlugin(name = "BackupFolder")
public class BackupFolderPlugin extends Plugin {
    // SAF providers can be slow (especially cloud-backed folders). Keep all
    // file work serialized on one background thread so the WebView and Android
    // main thread remain responsive while preserving operation ordering.
    private final ExecutorService storageExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "CueMark-Storage");
        thread.setDaemon(true);
        return thread;
    });

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.reject("User cancelled folder selection");
            return;
        }

        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.reject("No folder was returned");
            return;
        }

        getContext().getContentResolver().takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        );

        JSObject result_ = new JSObject();
        result_.put("uri", treeUri.toString());
        call.resolve(result_);
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        storageExecutor.execute(() -> doWriteFile(call));
    }

    private void doWriteFile(PluginCall call) {
        String treeUriStr = call.getString("uri");
        String fileName = call.getString("fileName");
        String content = call.getString("content");

        if (treeUriStr == null || fileName == null || content == null) {
            call.reject("Missing 'uri', 'fileName', or 'content' parameter");
            return;
        }

        try {
            Uri treeUri = Uri.parse(treeUriStr);
            Uri dirUri = DocumentsContract.buildDocumentUriUsingTree(
                treeUri,
                DocumentsContract.getTreeDocumentId(treeUri)
            );

            Uri existing = findChildDocument(treeUri, dirUri, fileName);
            Uri targetUri = existing != null
                ? existing
                : DocumentsContract.createDocument(getContext().getContentResolver(), dirUri, "application/json", fileName);

            if (targetUri == null) {
                call.reject("Failed to create backup file in the selected folder");
                return;
            }

            OutputStream out = getContext().getContentResolver().openOutputStream(targetUri, "wt");
            if (out == null) {
                call.reject("Failed to open backup file for writing");
                return;
            }
            out.write(content.getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.close();

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("uri", targetUri.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to write backup file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        storageExecutor.execute(() -> doReadFile(call));
    }

    private void doReadFile(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("Missing 'uri' parameter");
            return;
        }

        try {
            Uri uri = Uri.parse(uriStr);
            InputStream in = getContext().getContentResolver().openInputStream(uri);
            if (in == null) {
                call.reject("Failed to open file for reading");
                return;
            }

            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int bytesRead;
            while ((bytesRead = in.read(chunk)) != -1) {
                buffer.write(chunk, 0, bytesRead);
            }
            in.close();

            JSObject result = new JSObject();
            result.put("content", buffer.toString("UTF-8"));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to read backup file: " + e.getMessage(), e);
        }
    }

    // Reads an arbitrary file's raw bytes as base64 — unlike readFile (which decodes
    // as UTF-8 text), this is safe for binary formats like the .tar backup archive.
    @PluginMethod
    public void readBinaryFile(PluginCall call) {
        storageExecutor.execute(() -> doReadBinaryFile(call));
    }

    private void doReadBinaryFile(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("Missing 'uri' parameter");
            return;
        }

        try {
            Uri uri = Uri.parse(uriStr);
            InputStream in = getContext().getContentResolver().openInputStream(uri);
            if (in == null) {
                call.reject("Failed to open file for reading");
                return;
            }

            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int bytesRead;
            while ((bytesRead = in.read(chunk)) != -1) {
                buffer.write(chunk, 0, bytesRead);
            }
            in.close();

            JSObject result = new JSObject();
            result.put("base64Content", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to read binary file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void listFiles(PluginCall call) {
        storageExecutor.execute(() -> doListFiles(call));
    }

    private void doListFiles(PluginCall call) {
        String treeUriStr = call.getString("uri");
        if (treeUriStr == null) {
            call.reject("Missing 'uri' parameter");
            return;
        }

        try {
            Uri treeUri = Uri.parse(treeUriStr);
            Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
                treeUri,
                DocumentsContract.getTreeDocumentId(treeUri)
            );

            JSObject result = new JSObject();
            com.getcapacitor.JSArray files = new com.getcapacitor.JSArray();

            Cursor cursor = getContext().getContentResolver().query(
                childrenUri,
                new String[] {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED
                },
                null, null, null
            );

            if (cursor != null) {
                while (cursor.moveToNext()) {
                String docId = cursor.getString(0);
                String name = cursor.getString(1);
                Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);

                JSObject file = new JSObject();
                file.put("name", name);
                file.put("uri", docUri.toString());
                if (!cursor.isNull(2)) file.put("size", cursor.getLong(2));
                if (!cursor.isNull(3)) file.put("lastModified", cursor.getLong(3));
                files.put(file);
                }
                cursor.close();
            }

            result.put("files", files);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to list files: " + e.getMessage(), e);
        }
    }

    // Deletes a single file by its own document URI. Used only for rotating old
    // auto-backup archives — never called on a folder, so this can't cascade into
    // deleting cuemark-db/ or any of its contents.
    @PluginMethod
    public void deleteFile(PluginCall call) {
        storageExecutor.execute(() -> doDeleteFile(call));
    }

    private void doDeleteFile(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("Missing 'uri' parameter");
            return;
        }

        try {
            Uri uri = Uri.parse(uriStr);
            boolean deleted = DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
            JSObject result = new JSObject();
            result.put("success", deleted);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to delete file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void hasPersistedFolder(PluginCall call) {
        storageExecutor.execute(() -> doHasPersistedFolder(call));
    }

    @PluginMethod
    public void rememberFolder(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null || uri.isEmpty()) {
            call.reject("Missing folder URI");
            return;
        }
        getContext().getSharedPreferences("cuemark_backup_location", android.content.Context.MODE_PRIVATE)
            .edit().putString("uri", uri).apply();
        call.resolve(new JSObject().put("success", true));
    }

    private void doHasPersistedFolder(PluginCall call) {
        String treeUriStr = call.getString("uri");
        boolean valid = false;

        if (treeUriStr != null && !treeUriStr.isEmpty()) {
            try {
                Uri treeUri = Uri.parse(treeUriStr);
                for (android.content.UriPermission perm : getContext().getContentResolver().getPersistedUriPermissions()) {
                    if (perm.getUri().equals(treeUri) && perm.isWritePermission()) {
                        Uri rootUri = DocumentsContract.buildDocumentUriUsingTree(
                            treeUri,
                            DocumentsContract.getTreeDocumentId(treeUri)
                        );
                        try (Cursor cursor = getContext().getContentResolver().query(
                            rootUri,
                            new String[] {
                                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                                DocumentsContract.Document.COLUMN_MIME_TYPE
                            },
                            null, null, null
                        )) {
                            if (cursor != null && cursor.moveToFirst()) {
                                String mimeType = cursor.getString(1);
                                boolean isDirectory = DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType);
                                // Some SAF providers report zero flags for a writable
                                // tree. The persisted write grant is the authoritative
                                // permission; querying the directory proves the location
                                // is still reachable.
                                valid = isDirectory;
                            }
                        }
                        break;
                    }
                }
            } catch (Exception ignored) {
                // A revoked grant, removed SD card, or unavailable cloud provider
                // is reported to JavaScript as an invalid storage location.
                valid = false;
            }
        }

        JSObject result = new JSObject();
        result.put("valid", valid);
        call.resolve(result);
    }

    private Uri findChildDocument(Uri treeUri, Uri parentDocUri, String childName) {
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
            treeUri,
            DocumentsContract.getDocumentId(parentDocUri)
        );

        Cursor cursor = getContext().getContentResolver().query(
            childrenUri,
            new String[] {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME
            },
            null, null, null
        );

        Uri found = null;
        if (cursor != null) {
            while (cursor.moveToNext()) {
                String docId = cursor.getString(0);
                String name = cursor.getString(1);
                if (childName.equals(name)) {
                    found = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
                    break;
                }
            }
            cursor.close();
        }
        return found;
    }

    // Resolves dirPath (e.g. ["cuemark-db", "series", "cobra_kai"]) under the tree root,
    // creating any missing folder along the way. Each segment requires its own SAF
    // round-trip since there is no path-based lookup or recursive mkdir in DocumentsContract.
    private Uri getOrCreateDir(Uri treeUri, String[] pathSegments) throws Exception {
        Uri currentDir = DocumentsContract.buildDocumentUriUsingTree(
            treeUri,
            DocumentsContract.getTreeDocumentId(treeUri)
        );

        for (String segment : pathSegments) {
            Uri existing = findChildDocument(treeUri, currentDir, segment);
            if (existing != null) {
                currentDir = existing;
                continue;
            }
            Uri created = DocumentsContract.createDocument(
                getContext().getContentResolver(),
                currentDir,
                DocumentsContract.Document.MIME_TYPE_DIR,
                segment
            );
            if (created == null) {
                throw new Exception("Failed to create folder: " + segment);
            }
            currentDir = created;
        }

        return currentDir;
    }

    private Uri getOrCreateFile(Uri treeUri, Uri parentDirUri, String fileName, String mimeType) throws Exception {
        Uri existing = findChildDocument(treeUri, parentDirUri, fileName);
        if (existing != null) return existing;

        Uri created = DocumentsContract.createDocument(
            getContext().getContentResolver(),
            parentDirUri,
            mimeType,
            fileName
        );
        if (created == null) {
            throw new Exception("Failed to create file: " + fileName);
        }
        return created;
    }

    // Writes textContent to <root>/<dirPath...>/<fileName>, creating any missing folders.
    // Used by the cuemark-db/ category/item folder-tree mirror.
    @PluginMethod
    public void writeNestedFile(PluginCall call) {
        storageExecutor.execute(() -> doWriteNestedFile(call));
    }

    private void doWriteNestedFile(PluginCall call) {
        String treeUriStr = call.getString("uri");
        JSArray dirPathArr = call.getArray("dirPath");
        String fileName = call.getString("fileName");
        String content = call.getString("content");

        if (treeUriStr == null || dirPathArr == null || fileName == null || content == null) {
            call.reject("Missing 'uri', 'dirPath', 'fileName', or 'content' parameter");
            return;
        }

        try {
            Uri treeUri = Uri.parse(treeUriStr);
            String[] dirPath = jsArrayToStringArray(dirPathArr);
            Uri dirUri = getOrCreateDir(treeUri, dirPath);
            Uri fileUri = getOrCreateFile(treeUri, dirUri, fileName, "application/json");

            OutputStream out = getContext().getContentResolver().openOutputStream(fileUri, "wt");
            if (out == null) {
                call.reject("Failed to open file for writing");
                return;
            }
            out.write(content.getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.close();

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("uri", fileUri.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to write nested file: " + e.getMessage(), e);
        }
    }

    // Writes base64Content (decoded to raw bytes) to <root>/<dirPath...>/<fileName>.
    // Used for .thumbnail files in the cuemark-db/ folder-tree mirror.
    @PluginMethod
    public void writeNestedBinaryFile(PluginCall call) {
        storageExecutor.execute(() -> doWriteNestedBinaryFile(call));
    }

    private void doWriteNestedBinaryFile(PluginCall call) {
        String treeUriStr = call.getString("uri");
        JSArray dirPathArr = call.getArray("dirPath");
        String fileName = call.getString("fileName");
        String base64Content = call.getString("base64Content");

        if (treeUriStr == null || dirPathArr == null || fileName == null || base64Content == null) {
            call.reject("Missing 'uri', 'dirPath', 'fileName', or 'base64Content' parameter");
            return;
        }

        try {
            Uri treeUri = Uri.parse(treeUriStr);
            String[] dirPath = jsArrayToStringArray(dirPathArr);
            Uri dirUri = getOrCreateDir(treeUri, dirPath);
            Uri fileUri = getOrCreateFile(treeUri, dirUri, fileName, "application/octet-stream");

            byte[] bytes = Base64.decode(base64Content, Base64.DEFAULT);

            OutputStream out = getContext().getContentResolver().openOutputStream(fileUri, "wt");
            if (out == null) {
                call.reject("Failed to open file for writing");
                return;
            }
            out.write(bytes);
            out.flush();
            out.close();

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("uri", fileUri.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to write nested binary file: " + e.getMessage(), e);
        }
    }

    private String[] jsArrayToStringArray(JSArray arr) throws Exception {
        java.util.List<Object> list = arr.toList();
        String[] out = new String[list.size()];
        for (int i = 0; i < list.size(); i++) {
            out[i] = String.valueOf(list.get(i));
        }
        return out;
    }

    // Recursively archives everything under <root>/<sourceDirPath...> (i.e. cuemark-db/)
    // into a POSIX tar, and writes it as <root>/<tarFileName> — a sibling of the
    // source folder, not inside it. Walking + tarring natively avoids round-tripping
    // every file's bytes through the JS bridge twice (once to read, once to re-write).
    @PluginMethod
    public void exportTarArchive(PluginCall call) {
        storageExecutor.execute(() -> doExportTarArchive(call));
    }

    private void doExportTarArchive(PluginCall call) {
        String treeUriStr = call.getString("uri");
        JSArray sourceDirPathArr = call.getArray("sourceDirPath");
        String tarFileName = call.getString("tarFileName");
        String extraJsonFileName = call.getString("extraJsonFileName");
        String extraJsonContent = call.getString("extraJsonContent");

        if (treeUriStr == null || sourceDirPathArr == null || tarFileName == null) {
            call.reject("Missing 'uri', 'sourceDirPath', or 'tarFileName' parameter");
            return;
        }

        try {
            Uri treeUri = Uri.parse(treeUriStr);
            String[] sourceDirPath = jsArrayToStringArray(sourceDirPathArr);
            Uri sourceDirUri = getOrCreateDir(treeUri, sourceDirPath);
            String rootFolderName = sourceDirPath[sourceDirPath.length - 1];

            Uri rootDir = DocumentsContract.buildDocumentUriUsingTree(
                treeUri,
                DocumentsContract.getTreeDocumentId(treeUri)
            );
            Uri tarUri = getOrCreateFile(treeUri, rootDir, tarFileName, "application/x-tar");

            OutputStream rawOut = getContext().getContentResolver().openOutputStream(tarUri, "wt");
            if (rawOut == null) {
                call.reject("Failed to open tar file for writing");
                return;
            }

            TarWriter tar = new TarWriter(rawOut);
            if (extraJsonFileName != null && extraJsonContent != null) {
                tar.writeEntry(extraJsonFileName, extraJsonContent.getBytes(StandardCharsets.UTF_8));
            }
            addDirToTar(treeUri, sourceDirUri, rootFolderName, tar);
            tar.finish();
            rawOut.close();

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("uri", tarUri.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to export tar archive: " + e.getMessage(), e);
        }
    }

    private void addDirToTar(Uri treeUri, Uri dirUri, String archivePathPrefix, TarWriter tar) throws Exception {
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
            treeUri,
            DocumentsContract.getDocumentId(dirUri)
        );

        Cursor cursor = getContext().getContentResolver().query(
            childrenUri,
            new String[] {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            },
            null, null, null
        );

        if (cursor == null) return;

        while (cursor.moveToNext()) {
            String docId = cursor.getString(0);
            String name = cursor.getString(1);
            String mimeType = cursor.getString(2);
            Uri childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
            String archivePath = archivePathPrefix + "/" + name;

            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType)) {
                addDirToTar(treeUri, childUri, archivePath, tar);
            } else {
                InputStream in = getContext().getContentResolver().openInputStream(childUri);
                if (in == null) continue;
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int bytesRead;
                while ((bytesRead = in.read(chunk)) != -1) {
                    buffer.write(chunk, 0, bytesRead);
                }
                in.close();
                tar.writeEntry(archivePath, buffer.toByteArray());
            }
        }
        cursor.close();
    }

    // Minimal POSIX (ustar) tar writer: 512-byte header per entry, content padded
    // to a 512-byte boundary, and a 1024-byte zero-block trailer. No compression —
    // gzip would need a native Deflater wrapper, and plain tar is enough here since
    // the cuemark-db/ files (JSON + WebP) are already small and mostly incompressible.
    private static class TarWriter {
        private final OutputStream out;

        TarWriter(OutputStream out) {
            this.out = out;
        }

        void writeEntry(String path, byte[] content) throws Exception {
            byte[] header = new byte[512];
            byte[] nameBytes = path.getBytes(StandardCharsets.UTF_8);
            System.arraycopy(nameBytes, 0, header, 0, Math.min(nameBytes.length, 100));

            writeOctal(header, 100, 8, 0644);
            writeOctal(header, 108, 8, 0);
            writeOctal(header, 116, 8, 0);
            writeOctal(header, 124, 12, content.length);
            writeOctal(header, 136, 12, System.currentTimeMillis() / 1000);
            header[156] = '0';
            System.arraycopy("ustar\0".getBytes(StandardCharsets.US_ASCII), 0, header, 257, 6);
            System.arraycopy("00".getBytes(StandardCharsets.US_ASCII), 0, header, 263, 2);

            for (int i = 148; i < 156; i++) header[i] = ' ';
            int checksum = 0;
            for (byte b : header) checksum += (b & 0xFF);
            writeOctal(header, 148, 8, checksum);
            header[154] = 0;

            out.write(header);
            out.write(content);
            int padding = (512 - (content.length % 512)) % 512;
            if (padding > 0) out.write(new byte[padding]);
        }

        void finish() throws Exception {
            out.write(new byte[1024]);
        }

        private void writeOctal(byte[] header, int offset, int length, long value) {
            String octal = Long.toOctalString(value);
            int padLength = length - 1 - octal.length();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < padLength; i++) sb.append('0');
            sb.append(octal);
            byte[] bytes = sb.toString().getBytes(StandardCharsets.US_ASCII);
            System.arraycopy(bytes, 0, header, offset, Math.min(bytes.length, length - 1));
            header[offset + length - 1] = 0;
        }
    }
}
