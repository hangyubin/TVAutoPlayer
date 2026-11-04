package com.chenwei.tvautoplay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

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

        // Remote mode: the playlist comes from the CMS server, so the local
        // playlist may legitimately be empty. Launch whenever auto-start is on
        // and a server address has been configured.
        boolean launchRemote = store.isRemoteModeEnabled()
                && !store.serverUrl().isEmpty()
                && configuration.autoStartEnabled();
        if (!launchRemote) {
            ResolvedPlaylist effective = ScheduleResolver.resolve(
                    configuration.playlist(),
                    configuration.scheduledPlaylists(),
                    configuration.scheduleEnabled(),
                    ScheduleClock.currentMinuteOfDay()
            );
            int readableMediaCount = UriAccess.readableItems(
                    context,
                    effective.playlist()
            ).size();
            if (!PlaybackPolicy.shouldLaunchOnBoot(
                    configuration,
                    effective.playlist(),
                    readableMediaCount
            )) {
                Log.i(TAG, "Boot launch skipped because playback is not ready or auto-start is off");
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
