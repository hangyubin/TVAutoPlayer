package com.chenwei.tvautoplay;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
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

    private final String baseUrl;

    public RemoteManifestClient(String baseUrl) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
    }

    public String baseUrl() {
        return baseUrl;
    }

    /** 只返回成功；失败抛 FetchException（含错误信息，面向用户）。 */
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
                throw new FetchException("管理后台尚未发布任何版本，请先在服务端发布一次。");
            }
            if (code < 200 || code >= 300) {
                throw new FetchException("服务端返回 " + code + "：" + safeBody(conn));
            }
            String body = readAll(conn);
            return parse(body);
        } catch (IOException ioe) {
            throw new FetchException("无法连接到 " + baseUrl + "：" + ioe.getMessage());
        } catch (JSONException je) {
            throw new FetchException("manifest 格式错误：" + je.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // ---------- JSON parsing ----------

    Manifest parse(String raw) throws JSONException {
        JSONObject root = new JSONObject(raw);
        int schemaVersion = root.optInt("schemaVersion", -1);
        if (schemaVersion != SCHEMA_VERSION) {
            throw new JSONException("不支持的 schemaVersion：" + schemaVersion + "（仅支持 " + SCHEMA_VERSION + "）");
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
        try (BufferedReader r = new BufferedReader(new InputStreamReader(
                conn.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
            return sb.toString();
        }
    }

    private static String safeBody(HttpURLConnection conn) {
        try {
            if (conn.getErrorStream() == null) return "";
            return readAll(conn).trim();
        } catch (Exception e) { return ""; }
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
