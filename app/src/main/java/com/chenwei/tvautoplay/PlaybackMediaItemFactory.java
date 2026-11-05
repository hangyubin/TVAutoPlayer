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
            // 服务端节目单可为每张图片单独设置秒数；未设置时跟随设备全局时长
            long durationMs = item.durationSec() != null
                    ? item.durationSec() * 1_000L
                    : imageDuration.milliseconds();
            builder.setImageDurationMs(durationMs);
        }
        return builder.build();
    }
}
