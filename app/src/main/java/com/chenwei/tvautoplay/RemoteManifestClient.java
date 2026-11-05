package com.chenwei.tvautoplay;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * HTTP client for the self-hosted CMS server manifest endpoint.
 * Called on a background thread; never blocks the UI.
 *
 * <pre>
 *   try {
 *       RemoteManifestClient.Manifest m = new RemoteManifestClient(serverUrl).fetch();
 *       // m.contentVersion, m.defaultProgram, m.schedules...
 *   } catch (RemoteManifestClient.FetchException e) { ... }
 * </pre>
 */
public final class RemoteManifestClient {
    public static final int SCHEMA_VERSION = 1;
    /** 30 s suggested default; callers are free to override. */
    public static final long DEFAULT_POLL_INTERVAL_MS = 30_000L;

    private static final int CONNECT_TIMEOUT_MS = 8_000;
    private static final int READ_TIMEOUT_MS = 15_000;
    /** The server holds the watch request up to 25 s, so allow a little more than that. */
    private static final int WATCH_READ_TIMEOUT_MS = 35_000;

    private final String baseUrl;

    public RemoteManifestClient(String baseUrl) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
    }

    public String baseUrl() {
        return baseUrl;
    }

    /** Returns on success; throws FetchException with a machine-readable code on failure. */
    public Manifest fetch() throws FetchException {
        String endpoint = baseUrl + "/api/manifest";
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(endpoint).openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            if (code == 404) {
                throw new FetchException("server_not_published");
            }
            if (code < 200 || code >= 300) {
                throw new FetchException("server_http_error:" + code);
            }
            String body = readAll(conn);
            return parse(body);
        } catch (IOException ioe) {
            throw new FetchException("connect_error:" + baseUrl);
        } catch (JSONException je) {
            throw new FetchException("parse_error");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Long-poll the server for a content change.
     * Returns as soon as the server-side contentVersion differs from {@code sinceVersion},
     * or after the server's hold window expires. Returns {@code sinceVersion} when unchanged.
     */
    public long watch(long sinceVersion) throws FetchException {
        String endpoint = baseUrl + "/api/watch?version=" + sinceVersion;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(endpoint).openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(WATCH_READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new FetchException("server_http_error:" + code);
            }
            JSONObject root = new JSONObject(readAll(conn));
            return root.optLong("contentVersion", sinceVersion);
        } catch (IOException ioe) {
            throw new FetchException("connect_error:" + baseUrl);
        } catch (JSONException je) {
            throw new FetchException("parse_error");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // ---------- JSON parsing ----------

    Manifest parse(String raw) throws JSONException, FetchException {
        JSONObject root = new JSONObject(raw);
        int schemaVersion = root.optInt("schemaVersion", -1);
        if (schemaVersion != SCHEMA_VERSION) {
            throw new FetchException(
                    "unsupported_schema_version:" + schemaVersion + ":" + SCHEMA_VERSION);
        }
        int contentVersion = root.optInt("contentVersion", 0);
        JSONObject defaultProgram = root.optJSONObject("defaultProgram");
        JSONArray schedules = root.optJSONArray("schedules");
        return new Manifest(
                contentVersion,
                parseProgram(defaultProgram, baseUrl),
                parseSchedules(schedules, baseUrl)
        );
    }

    private static List<ManifestItem> parseProgram(JSONObject obj, String baseUrl) throws JSONException {
        if (obj == null) return Collections.emptyList();
        JSONArray items = obj.optJSONArray("items");
        if (items == null) return Collections.emptyList();
        List<ManifestItem> out = new ArrayList<>(items.length());
        for (int i = 0; i < items.length(); i++) {
            out.add(parseItem(items.getJSONObject(i), baseUrl));
        }
        return out;
    }

    private static List<ManifestSchedule> parseSchedules(JSONArray arr, String baseUrl) throws JSONException {
        if (arr == null) return Collections.emptyList();
        List<ManifestSchedule> out = new ArrayList<>(arr.length());
        for (int i = 0; i < arr.length(); i++) {
            JSONObject s = arr.getJSONObject(i);
            out.add(new ManifestSchedule(
                    s.optString("id", ""),
                    s.optInt("startMinute", 0),
                    s.optInt("endMinute", 0),
                    s.optBoolean("enabled", true),
                    parseProgram(s.optJSONObject("program"), baseUrl)
            ));
        }
        return out;
    }

    private static ManifestItem parseItem(JSONObject item, String baseUrl) throws JSONException {
        String rel = item.optString("url", "");
        String absolute = buildAbsoluteMediaUrl(baseUrl, rel);
        MediaKind kind = MediaKind.fromStoredValue(item.optString("kind", "VIDEO"));
        String sha = item.optString("sha256", "");
        Integer durationSec = item.has("durationSec") && !item.isNull("durationSec")
                ? item.getInt("durationSec")
                : null;
        return new ManifestItem(absolute, sha, kind, durationSec);
    }

    private static String buildAbsoluteMediaUrl(String baseUrl, String relative) {
        if (relative == null || relative.isEmpty()) return "";
        if (relative.startsWith("http://") || relative.startsWith("https://")) return relative;
        return baseUrl + "/" + relative.replaceFirst("^/+", "");
    }

    // ---------- helpers ----------

    private static String normalizeBaseUrl(String raw) {
        if (raw == null) return "";
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) return "";
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
            trimmed = "http://" + trimmed;
        }
        // strip trailing slash(es)
        while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        return trimmed;
    }

    private static String readAll(HttpURLConnection conn) throws IOException {
        InputStream stream = conn.getResponseCode() >= 400
                ? conn.getErrorStream()
                : conn.getInputStream();
        if (stream == null) return "";
        try (BufferedReader r = new BufferedReader(new InputStreamReader(
                stream, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
            return sb.toString();
        }
    }

    // ---------- data classes ----------

    /** Parsed manifest payload. Never mutated after construction. */
    public static final class Manifest {
        public final int contentVersion;
        public final List<ManifestItem> defaultProgram;
        public final List<ManifestSchedule> schedules;

        Manifest(int contentVersion,
                 List<ManifestItem> defaultProgram,
                 List<ManifestSchedule> schedules) {
            this.contentVersion = contentVersion;
            this.defaultProgram = defaultProgram;
            this.schedules = schedules;
        }

        public boolean hasAnyMedia() {
            return !defaultProgram.isEmpty() || !schedules.isEmpty();
        }
    }

    /** One entry in defaultProgram or in a schedule's program. */
    public static final class ManifestItem {
        /** Absolute http(s) URL to the media file on the server. */
        public final String url;
        /** sha256 of the file for integrity / cache keys. May be empty. */
        public final String sha256;
        public final MediaKind kind;
        /** Per-item image duration override (seconds); null = use default. */
        public final Integer durationSec;

        ManifestItem(String url, String sha256, MediaKind kind, Integer durationSec) {
            this.url = url;
            this.sha256 = sha256;
            this.kind = kind;
            this.durationSec = durationSec;
        }
    }

    /** One daily program slot (mirrors server-side schedule). */
    public static final class ManifestSchedule {
        public final String id;
        public final int startMinute;
        public final int endMinute;
        public final boolean enabled;
        public final List<ManifestItem> program;

        ManifestSchedule(String id, int startMinute, int endMinute, boolean enabled,
                         List<ManifestItem> program) {
            this.id = id;
            this.startMinute = startMinute;
            this.endMinute = endMinute;
            this.enabled = enabled;
            this.program = program;
        }
    }

    /** Non-fatal fetch error with a user-readable message. */
    public static final class FetchException extends Exception {
        public FetchException(String message) { super(message); }
    }
}
