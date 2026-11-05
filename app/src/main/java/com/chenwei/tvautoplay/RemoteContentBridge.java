package com.chenwei.tvautoplay;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * Converts a parsed {@link RemoteManifestClient.Manifest} into an immutable
 * {@link PlaybackConfiguration} that the existing local playback engine can consume
 * without any change.
 *
 * <p>URLs on {@link PlaylistItem} entries become absolute {@code http://…} endpoints
 * pointing at the CMS server. ExoPlayer handles HTTP streaming natively, so the
 * current build does not yet need a local cache — that comes later.
 */
public final class RemoteContentBridge {
    private RemoteContentBridge() {}

    /**
     * Best-effort translation. Any missing/invalid field falls back to safe defaults.
     * Returns {@code null} when the manifest contains no playable items at all.
     */
    public static PlaybackConfiguration toLocalConfig(RemoteManifestClient.Manifest manifest) {
        return toLocalConfig(manifest, true, true, ScaleMode.FIT, ImageDuration.DEFAULT);
    }

    /**
     * Translates the manifest while keeping the TV's own audio / scale / image-duration
     * preferences, so server-driven content still respects the on-device settings.
     */
    public static PlaybackConfiguration toLocalConfig(
            RemoteManifestClient.Manifest manifest,
            boolean autoStartEnabled,
            boolean soundEnabled,
            ScaleMode scaleMode,
            ImageDuration imageDuration) {
        Objects.requireNonNull(manifest, "manifest");
        if (!manifest.hasAnyMedia()) return null;

        ImageDuration globalImageDuration =
                imageDuration == null ? ImageDuration.DEFAULT : imageDuration;

        List<PlaylistItem> defaultList = buildPlaylist(manifest.defaultProgram, globalImageDuration);
        List<ScheduledPlaylist> scheduled = new ArrayList<>();
        boolean scheduleEnabled = !manifest.schedules.isEmpty();
        for (RemoteManifestClient.ManifestSchedule s : manifest.schedules) {
            try {
                ScheduleRule rule = new ScheduleRule(s.id, s.startMinute, s.endMinute, s.enabled);
                List<PlaylistItem> items = buildPlaylist(s.program, globalImageDuration);
                if (!items.isEmpty()) {
                    scheduled.add(new ScheduledPlaylist(rule, items));
                }
            } catch (IllegalArgumentException ignored) {
                // skip malformed schedule entries rather than crash the whole bridge
            }
        }

        return new PlaybackConfiguration(
                defaultList.isEmpty() ? Collections.emptyList() : defaultList,
                autoStartEnabled,
                soundEnabled,
                scaleMode == null ? ScaleMode.FIT : scaleMode,
                globalImageDuration,
                scheduleEnabled,
                scheduled
        );
    }

    private static List<PlaylistItem> buildPlaylist(
            List<RemoteManifestClient.ManifestItem> items,
            ImageDuration ignored) {
        if (items == null || items.isEmpty()) return Collections.emptyList();
        List<PlaylistItem> out = new ArrayList<>(items.size());
        int seq = 1;
        for (RemoteManifestClient.ManifestItem it : items) {
            if (it == null || it.url == null || it.url.isEmpty()) continue;
            String name;
            if (it.kind == MediaKind.LIVE) {
                name = it.name.isEmpty() ? "Live stream #" + seq : it.name;
            } else if (it.kind == MediaKind.IMAGE) {
                name = "Remote image #" + seq;
            } else {
                name = "Remote video #" + seq;
            }
            out.add(new PlaylistItem(it.url, name, it.kind, it.durationSec));
            seq++;
        }
        return out;
    }
}
