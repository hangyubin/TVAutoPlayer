package com.chenwei.tvautoplay;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
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
    private final long terminalId;

    public RemoteManifestClient(String baseUrl) {
        this(baseUrl, 0L);
    }

    /** Identifies the paired terminal so the CMS can record last-seen status. */
    public RemoteManifestClient(String baseUrl, long terminalId) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
        this.terminalId = terminalId;
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
            if (terminalId > 0) {
                conn.setRequestProperty("X-Terminal-Id", String.valueOf(terminalId));
            }
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

    // ---------- pairing ----------

    /** Claims a 6-digit pairing code previously issued from the admin UI. */
    public static PairResult claim(String rawBaseUrl, String code, String deviceName)
            throws FetchException {
        String baseUrl = normalizeBaseUrl(rawBaseUrl);
        String endpoint = baseUrl + "/api/terminals/claim";
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(endpoint).openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            JSONObject payload = new JSONObject();
            payload.put("code", code);
            payload.put("name", deviceName);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = conn.getResponseCode();
            String body = readAll(conn);
            if (status >= 200 && status < 300) {
                JSONObject root = new JSONObject(body);
                return new PairResult(
                        root.optLong("terminalId", 0L),
                        root.optString("name", deviceName));
            }
            String detail = "";
            try {
                detail = new JSONObject(body).optString("error", "");
            } catch (JSONException ignored) {
                // Response body is not JSON; keep the generic rejection message.
            }
            throw new FetchException("pair_rejected:" + detail);
        } catch (IOException ioe) {
            throw new FetchException("connect_error:" + baseUrl);
        } catch (JSONException je) {
            throw new FetchException("parse_error");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // ---------- data classes ----------

    /** Result of a successful pairing claim. */
    public static final class PairResult {
        public final long terminalId;
        public final String name;

        PairResult(long terminalId, String name) {
            this.terminalId = terminalId;
            this.name = name;
        }
    }

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
