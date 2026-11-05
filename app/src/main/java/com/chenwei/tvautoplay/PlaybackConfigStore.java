package com.chenwei.tvautoplay;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.util.Collections;
import java.util.List;

/** Stores only non-sensitive playback preferences; media content is never copied. */
public final class PlaybackConfigStore {
    private static final String PREFS_NAME = "playback_configuration";
    private static final String KEY_PLAYLIST = "playlist_json";
    private static final String KEY_SCHEDULE_ENABLED = "schedule_enabled";
    private static final String KEY_SCHEDULED_PLAYLISTS = "scheduled_playlists_json";
    private static final String KEY_VIDEO_URI = "video_uri";
    private static final String KEY_DISPLAY_NAME = "display_name";
    private static final String KEY_AUTO_START = "auto_start";
    private static final String KEY_SOUND = "sound";
    private static final String KEY_SCALE_MODE = "scale_mode";
    private static final String KEY_IMAGE_DURATION = "image_duration";
    private static final String KEY_HINT_SHOWN = "settings_hint_shown";
    private static final String KEY_FIRST_LAUNCH_PROMPT = "first_launch_prompt_shown";
    // ----- Remote CMS server -----
    private static final String KEY_REMOTE_MODE = "remote_mode";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String KEY_REMOTE_VERSION = "remote_content_version";
    private static final String KEY_REMOTE_LAST_FETCH = "remote_last_fetch_ms";
    /** Previously chosen audio track (0-based), or -1 = follow the player default. */
    private static final String KEY_AUDIO_TRACK_INDEX = "audio_track_index";

    private final SharedPreferences preferences;

    public PlaybackConfigStore(Context context) {
        preferences = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public PlaybackConfiguration load() {
        List<PlaylistItem> playlist = loadPlaylist();
        return new PlaybackConfiguration(
                playlist,
                preferences.getBoolean(KEY_AUTO_START, true),
                preferences.getBoolean(KEY_SOUND, true),
                ScaleMode.fromStoredValue(preferences.getString(KEY_SCALE_MODE, null)),
                ImageDuration.fromStoredValue(
                        preferences.getString(KEY_IMAGE_DURATION, null)
                ),
                preferences.getBoolean(KEY_SCHEDULE_ENABLED, false),
                PlaybackConfigurationCodec.decodeSchedules(
                        preferences.getString(KEY_SCHEDULED_PLAYLISTS, null)
                )
        );
    }

    /** Retained for V1.0.0 call compatibility; new code should save the full playlist. */
    public void saveVideo(Uri uri, String displayName) {
        savePlaylist(Collections.singletonList(new PlaylistItem(uri.toString(), displayName)));
    }

    public void savePlaylist(List<PlaylistItem> playlist) {
        preferences.edit()
                .putString(KEY_PLAYLIST, PlaybackConfigurationCodec.encodePlaylist(playlist))
                .remove(KEY_VIDEO_URI)
                .remove(KEY_DISPLAY_NAME)
                .apply();
    }

    public void clearVideo() {
        clearPlaylist();
    }

    public void clearPlaylist() {
        preferences.edit()
                .remove(KEY_PLAYLIST)
                .remove(KEY_VIDEO_URI)
                .remove(KEY_DISPLAY_NAME)
                .apply();
    }

    public void setAutoStartEnabled(boolean enabled) {
        preferences.edit().putBoolean(KEY_AUTO_START, enabled).apply();
    }

    public void setSoundEnabled(boolean enabled) {
        preferences.edit().putBoolean(KEY_SOUND, enabled).apply();
    }

    public void setScaleMode(ScaleMode mode) {
        preferences.edit().putString(KEY_SCALE_MODE, mode.name()).apply();
    }

    public void setImageDuration(ImageDuration duration) {
        preferences.edit().putString(KEY_IMAGE_DURATION, duration.name()).apply();
    }

    public void setScheduleEnabled(boolean enabled) {
        preferences.edit().putBoolean(KEY_SCHEDULE_ENABLED, enabled).apply();
    }

    public void saveScheduledPlaylists(List<ScheduledPlaylist> scheduledPlaylists) {
        preferences.edit()
                .putString(
                        KEY_SCHEDULED_PLAYLISTS,
                        PlaybackConfigurationCodec.encodeSchedules(scheduledPlaylists)
                )
                .apply();
    }

    public boolean isSettingsHintShown() {
        return preferences.getBoolean(KEY_HINT_SHOWN, false);
    }

    public void markSettingsHintShown() {
        preferences.edit().putBoolean(KEY_HINT_SHOWN, true).apply();
    }

    /** True once the app has auto-opened settings on its very first launch. */
    public boolean isFirstLaunchPromptShown() {
        return preferences.getBoolean(KEY_FIRST_LAUNCH_PROMPT, false);
    }

    public void markFirstLaunchPromptShown() {
        preferences.edit().putBoolean(KEY_FIRST_LAUNCH_PROMPT, true).apply();
    }

    // ----- Remote CMS server -----

    public boolean isRemoteModeEnabled() {
        return preferences.getBoolean(KEY_REMOTE_MODE, false);
    }

    public void setRemoteModeEnabled(boolean enabled) {
        preferences.edit().putBoolean(KEY_REMOTE_MODE, enabled).apply();
    }

    public String serverUrl() {
        return preferences.getString(KEY_SERVER_URL, "");
    }

    public void setServerUrl(String url) {
        preferences.edit().putString(KEY_SERVER_URL, url == null ? "" : url.trim()).apply();
    }

    public int remoteContentVersion() {
        return preferences.getInt(KEY_REMOTE_VERSION, 0);
    }

    public void setRemoteContentVersion(int version) {
        preferences.edit().putInt(KEY_REMOTE_VERSION, version).apply();
    }

    public long remoteLastFetchMillis() {
        return preferences.getLong(KEY_REMOTE_LAST_FETCH, 0L);
    }

    public void setRemoteLastFetchMillis(long ts) {
        preferences.edit().putLong(KEY_REMOTE_LAST_FETCH, ts).apply();
    }

    /** -1 means "let player auto-pick default"; otherwise 0-based index within the audio track group. */
    public int preferredAudioTrackIndex() {
        return preferences.getInt(KEY_AUDIO_TRACK_INDEX, -1);
    }

    public void setPreferredAudioTrackIndex(int index) {
        preferences.edit().putInt(KEY_AUDIO_TRACK_INDEX, index).apply();
    }

    private List<PlaylistItem> loadPlaylist() {
        if (preferences.contains(KEY_PLAYLIST)) {
            return parsePlaylist(preferences.getString(KEY_PLAYLIST, "[]"));
        }

        String legacyUri = preferences.getString(KEY_VIDEO_URI, null);
        if (legacyUri == null || legacyUri.trim().isEmpty()) {
            return Collections.emptyList();
        }

        List<PlaylistItem> migrated = Collections.singletonList(new PlaylistItem(
                legacyUri,
                preferences.getString(KEY_DISPLAY_NAME, null)
        ));
        savePlaylist(migrated);
        return migrated;
    }

    private List<PlaylistItem> parsePlaylist(String storedValue) {
        return PlaybackConfigurationCodec.decodePlaylist(storedValue);
    }
}
