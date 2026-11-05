package com.chenwei.tvautoplay;

import android.net.Uri;

import androidx.annotation.OptIn;
import androidx.media3.common.MediaItem;
import androidx.media3.common.util.UnstableApi;

/** Converts persisted playlist entries into Media3 items without duplicating playback rules. */
@OptIn(markerClass = UnstableApi.class)
public final class PlaybackMediaItemFactory {
    private PlaybackMediaItemFactory() {
    }

    public static MediaItem create(PlaylistItem item, ImageDuration imageDuration) {
        MediaItem.Builder builder = new MediaItem.Builder().setUri(Uri.parse(item.uri()));
        if (item.kind() == MediaKind.IMAGE) {
            // Per-image seconds from the server program; if unset, fall back to the device default.
            long durationMs = item.durationSec() != null
                    ? item.durationSec() * 1_000L
                    : imageDuration.milliseconds();
            builder.setImageDurationMs(durationMs);
        }
        return builder.build();
    }
}
