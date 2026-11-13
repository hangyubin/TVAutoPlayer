package com.chenwei.tvautoplay;

import java.util.Objects;

/** Immutable reference to one user-selected image or video document. */
public final class PlaylistItem {
    private final String uri;
    private final String displayName;
    private final MediaKind kind;
    /** Per-item image display seconds from the server program; null = follow device default. */
    private final Integer durationSec;
    /**
     * External subtitle file URI (SRT/VTT/ASS…). Null or blank = rely on the video's
     * own embedded subtitle tracks (if any).
     */
    private final String subtitleUri;

    /** Legacy constructor: V1.0.0-V1.2.0 playlist entries were all videos. */
    public PlaylistItem(String uri, String displayName) {
        this(uri, displayName, MediaKind.VIDEO);
    }

    public PlaylistItem(String uri, String displayName, MediaKind kind) {
        this(uri, displayName, kind, null, null);
    }

    public PlaylistItem(String uri, String displayName, MediaKind kind, Integer durationSec) {
        this(uri, displayName, kind, durationSec, null);
    }

    public PlaylistItem(String uri, String displayName, MediaKind kind, Integer durationSec, String subtitleUri) {
        this.uri = requireValue(uri, "uri");
        String normalizedName = normalize(displayName);
        this.displayName = normalizedName == null ? this.uri : normalizedName;
        this.kind = Objects.requireNonNull(kind, "kind");
        this.durationSec = durationSec != null && durationSec > 0 ? durationSec : null;
        this.subtitleUri = normalize(subtitleUri);
    }

    public String uri() {
        return uri;
    }

    public String displayName() {
        return displayName;
    }

    public MediaKind kind() {
        return kind;
    }

    /** Image-only display seconds; null means the global ImageDuration setting applies. */
    public Integer durationSec() {
        return durationSec;
    }

    /** External subtitle file URI, or null when the video should use its own embedded tracks. */
    public String subtitleUri() {
        return subtitleUri;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof PlaylistItem)) {
            return false;
        }
        PlaylistItem item = (PlaylistItem) other;
        return uri.equals(item.uri)
                && displayName.equals(item.displayName)
                && kind == item.kind
                && Objects.equals(durationSec, item.durationSec)
                && Objects.equals(subtitleUri, item.subtitleUri);
    }

    @Override
    public int hashCode() {
        return Objects.hash(uri, displayName, kind, durationSec, subtitleUri);
    }

    private static String requireValue(String value, String fieldName) {
        String normalized = normalize(value);
        if (normalized == null) {
            throw new IllegalArgumentException(fieldName + " must not be blank");
        }
        return normalized;
    }

    private static String normalize(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
