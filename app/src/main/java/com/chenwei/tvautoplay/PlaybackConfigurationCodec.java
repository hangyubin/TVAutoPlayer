package com.chenwei.tvautoplay;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Versioned JSON codec for playlists and scheduled playback configuration. */
public final class PlaybackConfigurationCodec {
    private static final int SCHEDULE_SCHEMA_VERSION = 1;

    private PlaybackConfigurationCodec() {
    }

    public static String encodePlaylist(List<PlaylistItem> playlist) {
        return encodePlaylistArray(PlaylistEditor.replace(playlist)).toString();
    }

    public static List<PlaylistItem> decodePlaylist(String storedValue) {
        try {
            return decodePlaylistArray(new JSONArray(storedValue == null ? "[]" : storedValue));
        } catch (JSONException | IllegalArgumentException exception) {
            return Collections.emptyList();
        }
    }

    public static String encodeSchedules(List<ScheduledPlaylist> schedules) {
        JSONObject root = new JSONObject();
        JSONArray scheduleArray = new JSONArray();
        try {
            root.put("schemaVersion", SCHEDULE_SCHEMA_VERSION);
            for (ScheduledPlaylist schedule : schedules) {
                if (schedule == null) {
                    continue;
                }
                JSONObject object = new JSONObject();
                ScheduleRule rule = schedule.rule();
                object.put("id", rule.id());
                object.put("startMinute", rule.startMinute());
                object.put("endMinute", rule.endMinute());
                object.put("enabled", rule.isEnabled());
                object.put("playlist", encodePlaylistArray(schedule.playlist()));
                scheduleArray.put(object);
            }
            root.put("schedules", scheduleArray);
        } catch (JSONException exception) {
            throw new IllegalStateException("Unable to serialize scheduled playlists", exception);
        }
        return root.toString();
    }

    public static List<ScheduledPlaylist> decodeSchedules(String storedValue) {
        if (storedValue == null || storedValue.trim().isEmpty()) {
            return Collections.emptyList();
        }

        try {
            JSONObject root = new JSONObject(storedValue);
            if (root.optInt("schemaVersion", -1) != SCHEDULE_SCHEMA_VERSION) {
                return Collections.emptyList();
            }
            JSONArray scheduleArray = root.optJSONArray("schedules");
            if (scheduleArray == null) {
                return Collections.emptyList();
            }

            List<ScheduledPlaylist> schedules = new ArrayList<>();
            for (int index = 0; index < scheduleArray.length(); index++) {
                JSONObject object = scheduleArray.optJSONObject(index);
                if (object == null) {
                    continue;
                }
                try {
                    ScheduleRule rule = new ScheduleRule(
                            object.optString("id", ""),
                            object.optInt("startMinute", -1),
                            object.optInt("endMinute", -1),
                            object.optBoolean("enabled", true)
                    );
                    JSONArray playlistArray = object.optJSONArray("playlist");
                    List<PlaylistItem> playlist = playlistArray == null
                            ? Collections.emptyList()
                            : decodePlaylistArray(playlistArray);
                    schedules.add(new ScheduledPlaylist(rule, playlist));
                } catch (IllegalArgumentException exception) {
                    // One corrupt entry must not prevent valid schedules from loading.
                }
            }
            return Collections.unmodifiableList(schedules);
        } catch (JSONException | IllegalArgumentException exception) {
            return Collections.emptyList();
        }
    }

    private static JSONArray encodePlaylistArray(List<PlaylistItem> playlist) {
        JSONArray array = new JSONArray();
        for (PlaylistItem item : playlist) {
            JSONObject object = new JSONObject();
            try {
                object.put("uri", item.uri());
                object.put("name", item.displayName());
                object.put("kind", item.kind().name());
                if (item.subtitleUri() != null) {
                    object.put("subtitleUri", item.subtitleUri());
                }
                array.put(object);
            } catch (JSONException exception) {
                throw new IllegalStateException("Unable to serialize playlist", exception);
            }
        }
        return array;
    }

    private static List<PlaylistItem> decodePlaylistArray(JSONArray array) {
        List<PlaylistItem> items = new ArrayList<>();
        for (int index = 0; index < array.length(); index++) {
            JSONObject object = array.optJSONObject(index);
            if (object == null) {
                continue;
            }
            String uri = object.optString("uri", null);
            if (uri == null || uri.trim().isEmpty()) {
                continue;
            }
            try {
                String subtitleUri = object.has("subtitleUri") && !object.isNull("subtitleUri")
                        ? object.optString("subtitleUri", null)
                        : null;
                items.add(new PlaylistItem(
                        uri,
                        object.optString("name", null),
                        MediaKind.fromStoredValue(object.optString("kind", null)),
                        null,
                        subtitleUri
                ));
            } catch (IllegalArgumentException exception) {
                // Skip the invalid item and preserve the rest of the playlist.
            }
        }
        return PlaylistEditor.replace(items);
    }
}
