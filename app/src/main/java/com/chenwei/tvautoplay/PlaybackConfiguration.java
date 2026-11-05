package com.chenwei.tvautoplay;

import java.util.Collections;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/** Immutable application settings shared by playback and boot-start decisions. */
public final class PlaybackConfiguration {
    private final List<PlaylistItem> playlist;
    private final boolean autoStartEnabled;
    private final boolean soundEnabled;
    private final ScaleMode scaleMode;
    private final ImageDuration imageDuration;
    private final boolean scheduleEnabled;
    private final List<ScheduledPlaylist> scheduledPlaylists;

    public PlaybackConfiguration(
            List<PlaylistItem> playlist,
            boolean autoStartEnabled,
            boolean soundEnabled,
            ScaleMode scaleMode
    ) {
        this(playlist, autoStartEnabled, soundEnabled, scaleMode, ImageDuration.DEFAULT);
    }

    public PlaybackConfiguration(
            List<PlaylistItem> playlist,
            boolean autoStartEnabled,
            boolean soundEnabled,
            ScaleMode scaleMode,
            ImageDuration imageDuration
    ) {
        this(
                playlist,
                autoStartEnabled,
                soundEnabled,
                scaleMode,
                imageDuration,
                false,
                Collections.emptyList()
        );
    }

    public PlaybackConfiguration(
            List<PlaylistItem> playlist,
            boolean autoStartEnabled,
            boolean soundEnabled,
            ScaleMode scaleMode,
            ImageDuration imageDuration,
            boolean scheduleEnabled,
            List<ScheduledPlaylist> scheduledPlaylists
    ) {
        // 不去重：远程节目单允许同一媒体按顺序出现多次（如 A-B-A 轮播）；
        // 本地选片的去重由 PlaylistEditor 在选取/解码入口负责
        this.playlist = Collections.unmodifiableList(
                new ArrayList<>(Objects.requireNonNull(playlist, "playlist")));
        this.autoStartEnabled = autoStartEnabled;
        this.soundEnabled = soundEnabled;
        this.scaleMode = Objects.requireNonNull(scaleMode, "scaleMode");
        this.imageDuration = Objects.requireNonNull(imageDuration, "imageDuration");
        this.scheduleEnabled = scheduleEnabled;
        this.scheduledPlaylists = Collections.unmodifiableList(
                new ArrayList<>(Objects.requireNonNull(scheduledPlaylists, "scheduledPlaylists"))
        );
    }

    /** Compatibility constructor for upgrading V1.0.0's single-video configuration. */
    public PlaybackConfiguration(
            String videoUri,
            String displayName,
            boolean autoStartEnabled,
            boolean soundEnabled,
            ScaleMode scaleMode
    ) {
        this(
                normalize(videoUri) == null
                        ? Collections.emptyList()
                        : Collections.singletonList(new PlaylistItem(videoUri, displayName)),
                autoStartEnabled,
                soundEnabled,
                scaleMode
        );
    }

    public static PlaybackConfiguration empty() {
        return new PlaybackConfiguration(
                Collections.emptyList(),
                true,
                true,
                ScaleMode.FIT,
                ImageDuration.DEFAULT
        );
    }

    public List<PlaylistItem> playlist() {
        return playlist;
    }

    public String videoUri() {
        return hasMedia() ? playlist.get(0).uri() : null;
    }

    public String displayName() {
        return hasMedia() ? playlist.get(0).displayName() : null;
    }

    public boolean autoStartEnabled() {
        return autoStartEnabled;
    }

    public boolean soundEnabled() {
        return soundEnabled;
    }

    public ScaleMode scaleMode() {
        return scaleMode;
    }

    public ImageDuration imageDuration() {
        return imageDuration;
    }

    public boolean scheduleEnabled() {
        return scheduleEnabled;
    }

    public List<ScheduledPlaylist> scheduledPlaylists() {
        return scheduledPlaylists;
    }

    public boolean hasMedia() {
        return !playlist.isEmpty();
    }

    public int mediaCount() {
        return playlist.size();
    }

    /** Compatibility alias retained for existing callers and tests. */
    public boolean hasVideo() {
        return hasMedia();
    }

    /** Compatibility alias retained for existing callers and tests. */
    public int videoCount() {
        return mediaCount();
    }

    private static String normalize(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
