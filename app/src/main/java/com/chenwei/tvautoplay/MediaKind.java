package com.chenwei.tvautoplay;

/** Supported playlist item categories. Unknown legacy values remain videos for compatibility. */
public enum MediaKind {
    VIDEO,
    IMAGE,
    /** Server-side live stream (HLS/m3u8); only appears in remote schedules. */
    LIVE;

    public static MediaKind fromStoredValue(String value) {
        if (IMAGE.name().equals(value)) {
            return IMAGE;
        }
        if (LIVE.name().equals(value)) {
            return LIVE;
        }
        return VIDEO;
    }
}
