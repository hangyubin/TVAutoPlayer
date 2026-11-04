package com.chenwei.tvautoplay;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import androidx.annotation.RequiresApi;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Scans only the fixed {@value #FOLDER_NAME} folder at the root of every external volume.
 *
 * <p>API 29+ uses MediaStore because scoped storage blocks direct file access to USB
 * volumes; API 23–28 walks the mounted volumes directly under {@code /storage}.
 */
public final class UsbMediaScanner {
    /** Only this folder at the root of the removable drive is played. */
    public static final String FOLDER_NAME = "TVAutoPlayer";
    private static final String TAG = "UsbMediaScanner";
    private static final int MAX_DEPTH = 4;

    private UsbMediaScanner() {
    }

    /** Returns supported images/videos sorted naturally by file name. Never null. */
    public static List<PlaylistItem> scan(Context context) {
        if (context == null) {
            return Collections.emptyList();
        }
        List<PlaylistItem> items = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? scanMediaStore(context)
                : scanFiles();
        sortNaturally(items);
        return items;
    }

    // ----- Android 10+ (scoped storage): MediaStore -----

    @RequiresApi(Build.VERSION_CODES.Q)
    private static List<PlaylistItem> scanMediaStore(Context context) {
        ContentResolver resolver = context.getContentResolver();
        List<PlaylistItem> found = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Uri collection : mediaCollections(context)) {
            queryCollection(resolver, collection, found, seen);
        }
        return found;
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private static Set<Uri> mediaCollections(Context context) {
        Set<Uri> collections = new LinkedHashSet<>();
        for (String volumeName : MediaStore.getExternalVolumeNames(context)) {
            collections.add(MediaStore.Images.Media.getContentUri(volumeName));
            collections.add(MediaStore.Video.Media.getContentUri(volumeName));
        }
        return collections;
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private static void queryCollection(
            ContentResolver resolver,
            Uri collection,
            List<PlaylistItem> destination,
            Set<String> seen
    ) {
        String[] projection = new String[]{
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.MIME_TYPE,
                MediaStore.MediaColumns.RELATIVE_PATH
        };
        try (Cursor cursor = resolver.query(collection, projection, null, null, null)) {
            if (cursor == null) {
                return;
            }
            int idColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
            int nameColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME);
            int mimeColumn = cursor.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE);
            int pathColumn = cursor.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH);
            while (cursor.moveToNext()) {
                String displayName = cursor.getString(nameColumn);
                if (displayName == null || displayName.trim().isEmpty()) {
                    continue;
                }
                String relativePath = pathColumn < 0 ? null : cursor.getString(pathColumn);
                if (!isInFixedFolder(relativePath)) {
                    continue;
                }
                String mimeType = mimeColumn < 0 ? null : cursor.getString(mimeColumn);
                MediaKind kind = MediaTypeDetector.detect(mimeType, displayName);
                if (kind == null) {
                    continue;
                }
                long id = cursor.getLong(idColumn);
                Uri contentUri = ContentUris.withAppendedId(collection, id);
                if (seen.add(contentUri.toString())) {
                    destination.add(new PlaylistItem(contentUri.toString(), displayName, kind));
                }
            }
        } catch (RuntimeException exception) {
            // A removable volume may disappear mid-scan; the remaining volumes still work.
            Log.w(TAG, "Unable to scan one media collection", exception);
        }
    }

    private static boolean isInFixedFolder(String relativePath) {
        if (relativePath == null) {
            return false;
        }
        String normalized = relativePath.replace('\\', '/');
        return normalized.equals(FOLDER_NAME)
                || normalized.equals(FOLDER_NAME + "/")
                || normalized.startsWith(FOLDER_NAME + "/");
    }

    // ----- Android 6–9: direct file scan -----

    @SuppressWarnings("deprecation")
    private static List<PlaylistItem> scanFiles() {
        List<PlaylistItem> found = new ArrayList<>();
        Set<String> seenPaths = new LinkedHashSet<>();
        for (File root : storageRoots()) {
            File folder = new File(root, FOLDER_NAME);
            if (!folder.isDirectory()) {
                continue;
            }
            walk(folder, found, seenPaths, 0);
        }
        return found;
    }

    @SuppressWarnings("deprecation")
    private static List<File> storageRoots() {
        Map<String, File> roots = new LinkedHashMap<>();
        addRoot(roots, Environment.getExternalStorageDirectory());
        File storage = new File("/storage");
        File[] mounted = storage.listFiles();
        if (mounted != null) {
            for (File file : mounted) {
                if (file.isDirectory() && !"self".equals(file.getName())) {
                    addRoot(roots, file);
                }
            }
        }
        return new ArrayList<>(roots.values());
    }

    private static void addRoot(Map<String, File> roots, File root) {
        if (root == null) {
            return;
        }
        try {
            String path = root.getCanonicalPath();
            roots.put(path, root);
        } catch (Exception ignored) {
            // Keep the raw path when canonicalization fails.
            roots.put(root.getAbsolutePath(), root);
        }
    }

    private static void walk(
            File folder,
            List<PlaylistItem> destination,
            Set<String> seenPaths,
            int depth
    ) {
        File[] children = folder.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            if (child.isDirectory()) {
                if (depth + 1 < MAX_DEPTH) {
                    walk(child, destination, seenPaths, depth + 1);
                }
                continue;
            }
            String name = child.getName();
            MediaKind kind = MediaTypeDetector.detect(null, name);
            if (kind == null) {
                continue;
            }
            String path = child.getAbsolutePath();
            if (seenPaths.add(path)) {
                destination.add(new PlaylistItem(Uri.fromFile(child).toString(), name, kind));
            }
        }
    }

    // ----- ordering -----

    private static void sortNaturally(List<PlaylistItem> items) {
        Collections.sort(items, new Comparator<PlaylistItem>() {
            @Override
            public int compare(PlaylistItem left, PlaylistItem right) {
                return naturalCompare(left.displayName(), right.displayName());
            }
        });
    }

    /** Case-insensitive comparison where "2" sorts before "10". */
    static int naturalCompare(String left, String right) {
        String a = left == null ? "" : left.toLowerCase(Locale.US);
        String b = right == null ? "" : right.toLowerCase(Locale.US);
        int i = 0;
        int j = 0;
        while (i < a.length() && j < b.length()) {
            char ca = a.charAt(i);
            char cb = b.charAt(j);
            if (Character.isDigit(ca) && Character.isDigit(cb)) {
                int startA = i;
                int startB = j;
                while (i < a.length() && Character.isDigit(a.charAt(i))) i++;
                while (j < b.length() && Character.isDigit(b.charAt(j))) j++;
                // Cap the digit run so an absurd file name cannot overflow Long.parseLong.
                String numberA = a.substring(startA, Math.min(i, startA + 9));
                String numberB = b.substring(startB, Math.min(j, startB + 9));
                long valueA = Long.parseLong(numberA);
                long valueB = Long.parseLong(numberB);
                if (valueA != valueB) {
                    return valueA < valueB ? -1 : 1;
                }
                continue;
            }
            if (ca != cb) {
                return ca < cb ? -1 : 1;
            }
            i++;
            j++;
        }
        return Integer.compare(a.length() - i, b.length() - j);
    }
}
