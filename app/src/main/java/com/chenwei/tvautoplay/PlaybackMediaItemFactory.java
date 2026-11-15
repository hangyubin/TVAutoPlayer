package com.chenwei.tvautoplay;

import android.net.Uri;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

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
        } else if (item.kind() == MediaKind.LIVE) {
            // Live URLs often lack a .m3u8 suffix; force the HLS source explicitly.
            builder.setMimeType(MimeTypes.APPLICATION_M3U8);
        }

        // External subtitle file — attach it to the MediaItem so Media3 loads it alongside
        // the video. Embedded subtitle tracks inside the container are discovered automatically
        // by the player; we don't need to list them here.
        if (item.subtitleUri() != null && item.subtitleUri().length() > 0) {
            List<MediaItem.SubtitleConfiguration> subs = new ArrayList<>(1);
            subs.add(subConfigFor(item.subtitleUri()));
            builder.setSubtitleConfigurations(subs);
        }
        return builder.build();
    }

    /**
     * Build a SubtitleConfiguration for the given URI, guessing MIME from file extension.
     * Only formats Media3's TextRenderer can parse are mapped here (SRT / VTT / ASS-SSA /
     * TTML); the server never links anything else.
     */
    private static MediaItem.SubtitleConfiguration subConfigFor(String subtitleUri) {
        String lower = subtitleUri.toLowerCase(Locale.ROOT);
        String mimeType;
        if (lower.endsWith(".vtt")) {
            mimeType = MimeTypes.TEXT_VTT;
        } else if (lower.endsWith(".ass") || lower.endsWith(".ssa")) {
            // Media3 registers its ASS/SSA parser under text/x-ssa; application/x-ssa
            // is silently ignored and the track would never render.
            mimeType = MimeTypes.TEXT_SSA;
        } else if (lower.endsWith(".ttml")) {
            mimeType = MimeTypes.APPLICATION_TTML;
        } else {
            // Default to SRT — by far the most common.
            mimeType = MimeTypes.APPLICATION_SUBRIP;
        }
        return new MediaItem.SubtitleConfiguration.Builder(Uri.parse(subtitleUri))
                .setMimeType(mimeType)
                .setSelectionFlags(C.SELECTION_FLAG_DEFAULT | C.SELECTION_FLAG_AUTOSELECT)
                .build();
    }
}
