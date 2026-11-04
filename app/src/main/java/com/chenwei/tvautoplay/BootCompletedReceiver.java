package com.chenwei.tvautoplay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.util.List;

/** Best-effort TV startup entry point; OEM background-launch policies still apply. */
public final class BootCompletedReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";
    private static final String ACTION_QUICK_BOOT = "android.intent.action.QUICKBOOT_POWERON";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !ACTION_QUICK_BOOT.equals(action)) {
            return;
        }

        PlaybackConfigStore store = new PlaybackConfigStore(context);
        PlaybackConfiguration configuration = store.load();
        if (!configuration.autoStartEnabled()) {
            Log.i(TAG, "Boot launch skipped because auto-start is off");
            return;
        }

        if (store.isRemoteModeEnabled()) {
            // Server mode: content comes from the CMS, so only the address matters.
            if (store.serverUrl().isEmpty()) {
                Log.i(TAG, "Boot launch skipped because the server address is empty");
                return;
            }
        } else {
            // USB mode: only launch when the fixed folder actually has playable media.
            if (!MediaPermissionHelper.hasReadAccess(context)) {
                Log.i(TAG, "Boot launch skipped because media read permission is missing");
                return;
            }
            List<PlaylistItem> items = UsbMediaScanner.scan(context);
            if (items.isEmpty()) {
                Log.i(TAG, "Boot launch skipped because the USB folder has no media");
                return;
            }
        }

        Intent launchIntent = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            context.startActivity(launchIntent);
        } catch (RuntimeException exception) {
            Log.e(TAG, "TV firmware blocked boot playback launch", exception);
        }
    }
}
