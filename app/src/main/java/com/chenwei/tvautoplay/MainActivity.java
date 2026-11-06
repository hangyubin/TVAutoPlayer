package com.chenwei.tvautoplay;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Full-screen TV playback surface for mixed image/video playlists. */
@OptIn(markerClass = UnstableApi.class)
public final class MainActivity extends ComponentActivity {
    private static final long SCHEDULE_CHECK_INTERVAL_MS = 30_000L;
    /** After a schedule falls back to the default program, wait this long before retrying it. */
    private static final long SCHEDULE_RETRY_COOLDOWN_MS = 5 * 60_000L;
    /** Retry delay when the long-poll request cannot reach the server. */
    private static final long WATCH_RETRY_DELAY_MS = 5_000L;
    /** Give the manifest fetch time to store the new version before re-arming the watch. */
    private static final long WATCH_SETTLE_MS = 1_500L;

    private final Handler scheduleHandler = new Handler(Looper.getMainLooper());
    private final Runnable scheduleCheck = this::checkForScheduleTransition;
    private final ExecutorService remoteFetcher = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "RemoteManifest");
        t.setDaemon(true);
        return t;
    });
    private final ExecutorService remoteWatcher = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "RemoteWatch");
        t.setDaemon(true);
        return t;
    });
    private final ExecutorService usbScanner = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "UsbScanner");
        t.setDaemon(true);
        return t;
    });
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private PlayerView playerView;
    private View emptyPanel;
    private View errorPanel;
    private TextView emptyMessage;
    private TextView errorMessage;
    private PlaybackConfigStore configStore;
    private ExoPlayer player;
    private boolean settingsOpen;
    private boolean selectionPromptAttempted;
    private boolean permissionRequested;
    private boolean usbScanInFlight;
    private int consecutivePlaybackFailures;
    private int activePlaylistSize;
    private String activePlaylistSourceId;
    /** Schedule whose items all failed and fell back to the default program. */
    private String failedScheduleId;
    /** Earliest time the failed schedule may be retried by the 30 s tick. */
    private long failedScheduleRetryAtMillis;
    /** Items the failed schedule was playing, used to tell a real edit from a time-only edit. */
    private List<PlaylistItem> failedSchedulePlaylist;
    private boolean activityStarted;
    private ActivityResultLauncher<Intent> settingsLauncher;
    private ActivityResultLauncher<String[]> permissionLauncher;
    /** Monotonic version of the config last rendered; remote version is pushed here too. */
    private int appliedRemoteVersion;
    private boolean remoteFetchInFlight;
    private boolean remoteWatchInFlight;
    /** Last remote configuration received; used for 30 s schedule-boundary checks. */
    private PlaybackConfiguration lastRemoteConfig;
    private List<PlaylistItem> currentPlayable = new ArrayList<>();
    /** Resume point of the default program, saved when a schedule takes over. */
    private int defaultResumeIndex = -1;
    private long defaultResumePositionMs;
    private String defaultResumeUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        settingsLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    settingsOpen = false;
                    startConfiguredPlayback();
                }
        );
        permissionLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestMultiplePermissions(),
                result -> startConfiguredPlayback()
        );
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                openSettings();
            }
        });
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);
        enterImmersiveMode();

        configStore = new PlaybackConfigStore(this);
        playerView = findViewById(R.id.player_view);
        emptyPanel = findViewById(R.id.empty_panel);
        errorPanel = findViewById(R.id.error_panel);
        emptyMessage = findViewById(R.id.empty_message);
        errorMessage = findViewById(R.id.error_message);

        Button openSettings = findViewById(R.id.open_settings_button);
        Button retry = findViewById(R.id.retry_button);
        Button errorSettings = findViewById(R.id.error_settings_button);

        openSettings.setOnClickListener(view -> openSettings());
        errorSettings.setOnClickListener(view -> openSettings());
        retry.setOnClickListener(view -> retryPlayback());
    }

    @Override
    protected void onStart() {
        super.onStart();
        activityStarted = true;
        startConfiguredPlayback();
        startRemoteWatch();
        scheduleHandler.removeCallbacks(scheduleCheck);
        scheduleHandler.postDelayed(scheduleCheck, SCHEDULE_CHECK_INTERVAL_MS);
    }

    @Override
    protected void onStop() {
        activityStarted = false;
        scheduleHandler.removeCallbacks(scheduleCheck);
        releasePlayer();
        super.onStop();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS) {
            openSettings();
            return true;
        }
        if (keyCode >= KeyEvent.KEYCODE_1 && keyCode <= KeyEvent.KEYCODE_9) {
            int index = keyCode - KeyEvent.KEYCODE_1;
            selectAudioTrack(index);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_0) {
            // 0 = reset to default audio track
            resetAudioTrackToDefault();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            enterImmersiveMode();
        }
    }

    private void startConfiguredPlayback() {
        if (configStore.isRemoteModeEnabled()) {
            fetchAndApplyRemoteManifest(false);
            return;
        }
        if (!MediaPermissionHelper.hasReadAccess(this)) {
            if (!permissionRequested) {
                permissionRequested = true;
                permissionLauncher.launch(MediaPermissionHelper.requiredPermissions());
            } else {
                showMediaPermissionRequired();
            }
            return;
        }
        requestUsbScan();
    }

    /** Scans the fixed USB folder off the UI thread, then renders only when content changed. */
    private void requestUsbScan() {
        if (usbScanInFlight) {
            return;
        }
        usbScanInFlight = true;
        usbScanner.execute(() -> {
            List<PlaylistItem> items = UsbMediaScanner.scan(this);
            mainHandler.post(() -> {
                usbScanInFlight = false;
                if (!activityStarted) {
                    return;
                }
                String signature = signatureOf(items);
                if (player != null && ("usb:" + signature).equals(activePlaylistSourceId)) {
                    return;
                }
                renderConfiguration(buildUsbConfiguration(items), "usb:" + signature);
            });
        });
    }

    /** USB mode keeps the TV's audio / scale / image-duration preferences. */
    private PlaybackConfiguration buildUsbConfiguration(List<PlaylistItem> items) {
        PlaybackConfiguration base = configStore.load();
        return new PlaybackConfiguration(
                items,
                base.autoStartEnabled(),
                base.soundEnabled(),
                base.scaleMode(),
                base.imageDuration(),
                false,
                Collections.emptyList()
        );
    }

    /** Stable content signature so a 30 s tick only re-renders when the drive changed. */
    private static String signatureOf(List<PlaylistItem> items) {
        StringBuilder builder = new StringBuilder();
        for (PlaylistItem item : items) {
            builder.append(item.uri()).append('|');
        }
        return Integer.toHexString(builder.toString().hashCode());
    }

    /**
     * Long-poll the server so admin edits take effect immediately instead of waiting
     * for the next fixed tick. The request parks on the server until the content
     * hash changes (or the hold window expires).
     */
    private void startRemoteWatch() {
        if (remoteWatchInFlight || !activityStarted || !configStore.isRemoteModeEnabled()) {
            return;
        }
        final String serverUrl = configStore.serverUrl();
        if (serverUrl.isEmpty()) {
            return;
        }
        remoteWatchInFlight = true;
        final int since = configStore.remoteContentVersion();
        remoteWatcher.execute(() -> {
            long observed;
            try {
                observed = new RemoteManifestClient(serverUrl).watch(since);
            } catch (RemoteManifestClient.FetchException e) {
                observed = -1;
            }
            final long result = observed;
            mainHandler.post(() -> {
                remoteWatchInFlight = false;
                if (!activityStarted || !configStore.isRemoteModeEnabled()) {
                    return;
                }
                if (result < 0) {
                    // Server unreachable: retry later without disturbing playback.
                    scheduleHandler.postDelayed(this::startRemoteWatch, WATCH_RETRY_DELAY_MS);
                } else if (result != since) {
                    fetchAndApplyRemoteManifest(false);
                    scheduleHandler.postDelayed(this::startRemoteWatch, WATCH_SETTLE_MS);
                } else {
                    startRemoteWatch();
                }
            });
        });
    }

    /** Non-blocking; runs on background thread, renders on main. */
    private void fetchAndApplyRemoteManifest(boolean force) {
        if (remoteFetchInFlight) return;
        remoteFetchInFlight = true;
        final String serverUrl = configStore.serverUrl();
        remoteFetcher.execute(() -> {
            final PlaybackConfiguration config;
            final int version;
            try {
                RemoteManifestClient.Manifest manifest =
                        new RemoteManifestClient(serverUrl).fetch();
                PlaybackConfiguration preferences = configStore.load();
                config = RemoteContentBridge.toLocalConfig(
                        manifest,
                        preferences.autoStartEnabled(),
                        preferences.soundEnabled(),
                        preferences.scaleMode(),
                        preferences.imageDuration()
                );
                version = manifest.contentVersion;
                configStore.setRemoteLastFetchMillis(System.currentTimeMillis());
                configStore.setRemoteContentVersion(version);
            } catch (RemoteManifestClient.FetchException e) {
                String host = serverUrl.isEmpty()
                        ? getString(R.string.remote_not_set)
                        : serverUrl;
                String detail = translateRemoteError(e.getMessage());
                String msg = getString(R.string.remote_prefix, detail);
                mainHandler.post(() -> renderRemoteError(host + ": " + detail, msg));
                return;
            } finally {
                remoteFetchInFlight = false;
            }
            mainHandler.post(() -> {
                if (config == null) {
                    renderRemoteError(
                            serverUrl.isEmpty()
                                    ? getString(R.string.remote_mode_label_short)
                                    : serverUrl,
                            getString(R.string.remote_empty_manifest));
                    return;
                }
                lastRemoteConfig = config;
                applyRemoteConfiguration(config, version, force);
            });
        });
    }

    /**
     * Applies a freshly fetched remote configuration without needlessly restarting
     * playback. A new content version does not always mean different playback: editing
     * another slot's time changes the manifest hash while the currently effective
     * playlist stays the same. Such updates are absorbed silently, and a playlist that
     * only grew at its tail is appended, keeping the current item's position and
     * progress instead of restarting it.
     */
    private void applyRemoteConfiguration(PlaybackConfiguration config, int version, boolean force) {
        if (!force && version > 0 && version == appliedRemoteVersion && player != null) {
            // Content hash unchanged and already playing — keep going.
            return;
        }
        appliedRemoteVersion = version;
        if (player != null) {
            ResolvedPlaylist effective = resolveEffectivePlaylist(config);
            if (effective.sourceId().equals(activePlaylistSourceId)) {
                List<PlaylistItem> next = effective.playlist();
                if (next.equals(currentPlayable)) {
                    // Identical playback: leave the player untouched.
                    return;
                }
                if (isTailAppend(currentPlayable, next)
                        && player.getMediaItemCount() == currentPlayable.size()) {
                    List<MediaItem> appended =
                            new ArrayList<>(next.size() - currentPlayable.size());
                    for (int i = currentPlayable.size(); i < next.size(); i++) {
                        appended.add(PlaybackMediaItemFactory.create(
                                next.get(i),
                                config.imageDuration()
                        ));
                    }
                    player.addMediaItems(appended);
                    currentPlayable = new ArrayList<>(next);
                    activePlaylistSize = next.size();
                    return;
                }
            }
            // A slot that failed and fell back to the default program stays cooling down
            // while its own items are unchanged. Editing only its time must not interrupt
            // the fallback program; editing its content still retries immediately.
            if (isScheduleCoolingDown(effective.sourceId())
                    && effective.playlist().equals(failedSchedulePlaylist)) {
                return;
            }
        }
        // Fresh content: drop any schedule-failure cooldown so admin fixes
        // (e.g. a corrected live URL) apply immediately.
        failedScheduleId = null;
        failedSchedulePlaylist = null;
        renderConfiguration(config, null);
    }

    /** True when {@code next} merely appends items after {@code current}. */
    private static boolean isTailAppend(List<PlaylistItem> current, List<PlaylistItem> next) {
        if (current.isEmpty() || next.size() <= current.size()) {
            return false;
        }
        return next.subList(0, current.size()).equals(current);
    }

    /** Translate a FetchException machine code into a localized user message. */
    private String translateRemoteError(String code) {
        if (code == null) return "";
        if (code.equals("server_not_published")) {
            return getString(R.string.remote_not_published);
        }
        if (code.startsWith("server_http_error:")) {
            try {
                int status = Integer.parseInt(code.substring("server_http_error:".length()));
                return getString(R.string.remote_http_error, status);
            } catch (NumberFormatException ignored) {}
        }
        if (code.startsWith("connect_error:")) {
            return getString(R.string.remote_connect_error, code.substring("connect_error:".length()));
        }
        if (code.equals("parse_error")) {
            return getString(R.string.remote_parse_error);
        }
        if (code.startsWith("unsupported_schema_version:")) {
            String[] parts = code.split(":");
            if (parts.length >= 3) {
                try {
                    int got = Integer.parseInt(parts[1]);
                    int want = Integer.parseInt(parts[2]);
                    return getString(R.string.remote_schema_unsupported, got, want);
                } catch (NumberFormatException ignored) {}
            }
        }
        return code;
    }

    private void renderRemoteError(String title, String detail) {
        showPlayer(); // make space for a toast
        Toast.makeText(this, getString(R.string.remote_prefix, detail), Toast.LENGTH_LONG).show();
        // If nothing is playing yet, swap in the error panel
        if (player == null || !player.isPlaying()) {
            releasePlayer();
            playerView.setVisibility(View.GONE);
            emptyPanel.setVisibility(View.VISIBLE);
            emptyMessage.setText(title + "\n" + detail);
        }
    }

    /** Unified playback renderer used by both local and remote paths. */
    private void renderConfiguration(PlaybackConfiguration configuration, String sourceTag) {
        ResolvedPlaylist effective = resolveEffectivePlaylist(configuration);
        String newSourceId = sourceTag != null ? sourceTag : effective.sourceId();
        boolean leavingDefaultProgram = isDefaultSource(activePlaylistSourceId)
                && !isDefaultSource(newSourceId);
        boolean returningToDefaultProgram = !isDefaultSource(activePlaylistSourceId)
                && isDefaultSource(newSourceId);
        if (leavingDefaultProgram) {
            // Remember where the default program was interrupted so a schedule boundary
            // can resume it instead of restarting from the first item.
            rememberDefaultProgress();
        }
        activePlaylistSourceId = newSourceId;
        // Remote items are absolute http(s) URLs; USB items were already verified by
        // the scanner (content:// on Android 10+, file:// on older TVs).
        List<PlaylistItem> playable = effective.playlist();
        PlaybackDecision decision = PlaybackPolicy.decide(
                effective.playlist(),
                playable.size()
        );
        if (decision != PlaybackDecision.READY) {
            releasePlayer();
            if (decision == PlaybackDecision.NEEDS_SELECTION
                    && configuration.scheduleEnabled()
                    && ScheduleResolver.hasEnabledPlaylist(
                            configuration.scheduledPlaylists()
                    )) {
                showWaitingForSchedule();
                return;
            }
            showSelectionRequired(decision);
            // Open settings automatically on first launch only; later launches show the
            // hint panel instead of hijacking the TV screen every boot.
            if (!settingsOpen && !selectionPromptAttempted
                    && !configStore.isFirstLaunchPromptShown()) {
                selectionPromptAttempted = true;
                configStore.markFirstLaunchPromptShown();
                openSettings();
            }
            return;
        }

        showPlayer();
        consecutivePlaybackFailures = 0;
        activePlaylistSize = playable.size();
        if (player == null) {
            createPlayer();
        }
        player.setVolume(configuration.soundEnabled() ? 1f : 0f);
        playerView.setResizeMode(configuration.scaleMode() == ScaleMode.ZOOM
                ? AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                : AspectRatioFrameLayout.RESIZE_MODE_FIT);
        List<MediaItem> mediaItems = new ArrayList<>(playable.size());
        for (PlaylistItem item : playable) {
            mediaItems.add(PlaybackMediaItemFactory.create(
                    item,
                    configuration.imageDuration()
            ));
        }
        // Reuse the player across source switches: swapping the playlist on a warm
        // instance keeps the video surface alive, avoiding the black flash and full
        // re-buffer that a release/rebuild cycle caused on every transition.
        int resumeIndex = 0;
        long resumePositionMs = 0L;
        if (returningToDefaultProgram) {
            int index = resolveDefaultResumeIndex(playable);
            if (index >= 0) {
                resumeIndex = index;
                resumePositionMs = defaultResumePositionMs;
            }
            defaultResumeIndex = -1;
            defaultResumeUri = null;
            defaultResumePositionMs = 0L;
        }
        if (resumeIndex > 0 || resumePositionMs > 0L) {
            player.setMediaItems(mediaItems, resumeIndex, resumePositionMs);
        } else {
            player.setMediaItems(mediaItems, true);
        }
        player.prepare();
        player.play();
        currentPlayable = playable;

        if (!configStore.isSettingsHintShown()) {
            Toast.makeText(this, R.string.settings_key_hint, Toast.LENGTH_LONG).show();
            configStore.markSettingsHintShown();
        }
    }

    private ResolvedPlaylist resolveEffectivePlaylist(PlaybackConfiguration configuration) {
        return ScheduleResolver.resolve(
                configuration.playlist(),
                configuration.scheduledPlaylists(),
                configuration.scheduleEnabled(),
                ScheduleClock.currentMinuteOfDay()
        );
    }

    private boolean isDefaultSource(String sourceId) {
        return sourceId == null || ResolvedPlaylist.DEFAULT_SOURCE_ID.equals(sourceId);
    }

    private void rememberDefaultProgress() {
        if (player == null || currentPlayable.isEmpty()) {
            return;
        }
        int index = player.getCurrentMediaItemIndex();
        if (index < 0 || index >= currentPlayable.size()) {
            return;
        }
        PlaylistItem item = currentPlayable.get(index);
        defaultResumeIndex = index;
        defaultResumeUri = item.uri();
        // Still images have no meaningful seek position; restart the image instead.
        defaultResumePositionMs = item.kind() == MediaKind.IMAGE
                ? 0L
                : Math.max(0L, player.getCurrentPosition());
    }

    /** Maps the saved default-program position onto the current playlist, or -1. */
    private int resolveDefaultResumeIndex(List<PlaylistItem> playable) {
        if (defaultResumeIndex < 0 || defaultResumeUri == null) {
            return -1;
        }
        if (defaultResumeIndex < playable.size()
                && defaultResumeUri.equals(playable.get(defaultResumeIndex).uri())) {
            return defaultResumeIndex;
        }
        // The default program may have been reordered while the schedule was playing.
        for (int i = 0; i < playable.size(); i++) {
            if (defaultResumeUri.equals(playable.get(i).uri())) {
                return i;
            }
        }
        return -1;
    }

    /** True while a schedule that just failed is waiting out its retry cooldown. */
    private boolean isScheduleCoolingDown(String sourceId) {
        return failedScheduleId != null
                && failedScheduleId.equals(sourceId)
                && System.currentTimeMillis() < failedScheduleRetryAtMillis;
    }

    private void checkForScheduleTransition() {
        if (!activityStarted) {
            return;
        }
        // Remote mode: refresh the manifest AND re-evaluate the schedule boundary.
        // The config cached from the last successful fetch carries the server-side
        // schedules, so a 30 s tick can switch programs without a new publish.
        if (configStore.isRemoteModeEnabled()) {
            PlaybackConfiguration remoteConfiguration = lastRemoteConfig;
            if (remoteConfiguration != null) {
                ResolvedPlaylist effective = resolveEffectivePlaylist(remoteConfiguration);
                if (!effective.sourceId().equals(activePlaylistSourceId)
                        && !isScheduleCoolingDown(effective.sourceId())) {
                    renderConfiguration(remoteConfiguration, effective.sourceId());
                }
            }
            // Content changes arrive through the long-poll watch, not this tick.
            startRemoteWatch();
            scheduleHandler.postDelayed(scheduleCheck, SCHEDULE_CHECK_INTERVAL_MS);
            return;
        }
        // USB mode: rescan periodically so a drive plugged in later starts playing.
        if (MediaPermissionHelper.hasReadAccess(this)) {
            requestUsbScan();
        }
        scheduleHandler.postDelayed(scheduleCheck, SCHEDULE_CHECK_INTERVAL_MS);
    }

    private void retryPlayback() {
        if (player == null) {
            startConfiguredPlayback();
            return;
        }
        consecutivePlaybackFailures = 0;
        errorPanel.setVisibility(View.GONE);
        player.prepare();
        player.play();
    }

    private void showPlayer() {
        playerView.setVisibility(View.VISIBLE);
        emptyPanel.setVisibility(View.GONE);
        errorPanel.setVisibility(View.GONE);
    }

    private void showSelectionRequired(PlaybackDecision decision) {
        playerView.setVisibility(View.GONE);
        errorPanel.setVisibility(View.GONE);
        emptyPanel.setVisibility(View.VISIBLE);
        if (decision == PlaybackDecision.PERMISSION_REQUIRED) {
            emptyMessage.setText(R.string.media_permission_required);
        } else {
            emptyMessage.setText(R.string.no_media_in_usb);
        }
    }

    private void showMediaPermissionRequired() {
        releasePlayer();
        playerView.setVisibility(View.GONE);
        errorPanel.setVisibility(View.GONE);
        emptyPanel.setVisibility(View.VISIBLE);
        emptyMessage.setText(R.string.media_permission_required);
    }

    private void showWaitingForSchedule() {
        playerView.setVisibility(View.GONE);
        errorPanel.setVisibility(View.GONE);
        emptyPanel.setVisibility(View.VISIBLE);
        emptyMessage.setText(R.string.no_active_schedule);
    }

    private void showPlaybackError(PlaybackException error) {
        errorMessage.setText(getString(R.string.playback_error_detail, error.getErrorCodeName()));
        errorPanel.setVisibility(View.VISIBLE);
        findViewById(R.id.retry_button).requestFocus();
    }

    private void handlePlaybackError(PlaybackException error) {
        consecutivePlaybackFailures++;
        if (player != null
                && activePlaylistSize > 1
                && consecutivePlaybackFailures < activePlaylistSize) {
            int currentIndex = Math.max(player.getCurrentMediaItemIndex(), 0);
            int nextIndex = (currentIndex + 1) % activePlaylistSize;
            player.seekTo(nextIndex, 0L);
            player.prepare();
            player.play();
            return;
        }
        if (fallbackToDefaultProgram()) {
            return;
        }
        showPlaybackError(error);
    }

    /**
     * A scheduled slot whose items all failed (typical case: a dead live stream) falls
     * back to the default program instead of parking on the error panel. The failed
     * schedule then enters a cooldown: the 30 s tick leaves the default program
     * untouched for a few minutes instead of restarting it on every retry. The next
     * retry happens after the cooldown, and any new content version clears it at once.
     */
    private boolean fallbackToDefaultProgram() {
        if (!configStore.isRemoteModeEnabled()
                || ResolvedPlaylist.DEFAULT_SOURCE_ID.equals(activePlaylistSourceId)) {
            return false;
        }
        PlaybackConfiguration config = lastRemoteConfig;
        if (config == null || config.playlist().isEmpty()) {
            return false;
        }
        failedScheduleId = activePlaylistSourceId;
        failedSchedulePlaylist = new ArrayList<>(currentPlayable);
        failedScheduleRetryAtMillis = System.currentTimeMillis() + SCHEDULE_RETRY_COOLDOWN_MS;
        PlaybackConfiguration fallback = new PlaybackConfiguration(
                config.playlist(),
                config.autoStartEnabled(),
                config.soundEnabled(),
                config.scaleMode(),
                config.imageDuration(),
                false,
                Collections.emptyList()
        );
        renderConfiguration(fallback, ResolvedPlaylist.DEFAULT_SOURCE_ID);
        return true;
    }

    private void openSettings() {
        if (settingsOpen) {
            return;
        }
        settingsOpen = true;
        Intent intent = new Intent(this, SettingsActivity.class);
        intent.putExtra(SettingsActivity.EXTRA_CURRENT_AUDIO_TRACK_COUNT,
                audioTrackEntries().size());
        settingsLauncher.launch(intent);
    }

    /**
     * Builds the single ExoPlayer instance reused for the activity lifetime. Source
     * switches only swap playlists on this warm instance, keeping transitions smooth.
     */
    private void createPlayer() {
        player = new ExoPlayer.Builder(this)
                .setAudioAttributes(
                        new AudioAttributes.Builder()
                                .setUsage(C.USAGE_MEDIA)
                                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                                .build(),
                        true
                )
                .build();
        player.setRepeatMode(Player.REPEAT_MODE_ALL);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(PlaybackException error) {
                handlePlaybackError(error);
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_READY) {
                    consecutivePlaybackFailures = 0;
                    if (activePlaylistSourceId != null
                            && activePlaylistSourceId.equals(failedScheduleId)) {
                        // The retried schedule plays again; clear its cooldown state.
                        failedScheduleId = null;
                        failedSchedulePlaylist = null;
                    }
                    errorPanel.setVisibility(View.GONE);
                }
            }

            @Override
            public void onTracksChanged(Tracks tracks) {
                // Tracks are only published after the renderers have probed the media,
                // which can happen slightly after STATE_READY. This is the reliable hook.
                applySavedAudioTrackOverride();
            }
        });
        playerView.setPlayer(player);
    }

    private void releasePlayer() {
        currentPlayable = new ArrayList<>();
        if (player != null) {
            playerView.setPlayer(null);
            player.release();
            player = null;
        }
        activePlaylistSize = 0;
        consecutivePlaybackFailures = 0;
    }

    // ---------- Audio track switching (remote 1-9 pick, 0 for default) ----------

    /** One selectable audio track: which group it belongs to and its index inside that group. */
    private static final class AudioTrackRef {
        final Tracks.Group group;
        final int indexInGroup;

        AudioTrackRef(Tracks.Group group, int indexInGroup) {
            this.group = group;
            this.indexInGroup = indexInGroup;
        }
    }

    /**
     * Flattens every audio track across all audio groups. A single MediaItem can expose several
     * audio groups (e.g. one per codec), so "track N" must be counted globally, not per group.
     */
    private List<AudioTrackRef> audioTrackEntries() {
        List<AudioTrackRef> entries = new ArrayList<>();
        if (player == null) return entries;
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() != C.TRACK_TYPE_AUDIO) continue;
            for (int i = 0; i < group.length; i++) {
                entries.add(new AudioTrackRef(group, i));
            }
        }
        return entries;
    }

    private void selectAudioTrack(int index) {
        if (player == null) return;
        List<AudioTrackRef> entries = audioTrackEntries();
        if (index >= entries.size()) return;
        AudioTrackRef ref = entries.get(index);
        if (!ref.group.isTrackSupported(ref.indexInGroup)) return;
        player.setTrackSelectionParameters(
                player.getTrackSelectionParameters().buildUpon()
                        .setOverrideForType(new TrackSelectionOverride(
                                ref.group.getMediaTrackGroup(), ref.indexInGroup))
                        .build());
        configStore.setPreferredAudioTrackIndex(index);
    }

    private void resetAudioTrackToDefault() {
        if (player == null) return;
        player.setTrackSelectionParameters(
                player.getTrackSelectionParameters().buildUpon()
                        .clearOverrides()
                        .build());
        configStore.setPreferredAudioTrackIndex(-1);
    }

    /** Applies the previously chosen audio track whenever the track list becomes available. */
    private void applySavedAudioTrackOverride() {
        if (player == null) return;
        int saved = configStore.preferredAudioTrackIndex();
        if (saved < 0) return;
        List<AudioTrackRef> entries = audioTrackEntries();
        if (saved >= entries.size()) return;
        AudioTrackRef ref = entries.get(saved);
        if (!ref.group.isTrackSupported(ref.indexInGroup)) return;
        // Already applied -> skip to avoid unnecessary override churn.
        if (ref.group.isTrackSelected(ref.indexInGroup)) return;
        player.setTrackSelectionParameters(
                player.getTrackSelectionParameters().buildUpon()
                        .setOverrideForType(new TrackSelectionOverride(
                                ref.group.getMediaTrackGroup(), ref.indexInGroup))
                        .build());
    }

    @SuppressWarnings("deprecation")
    private void enterImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }
            return;
        }
        enterLegacyImmersiveMode();
    }

    @SuppressWarnings("deprecation")
    private void enterLegacyImmersiveMode() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        scheduleHandler.removeCallbacks(scheduleCheck);
        remoteFetcher.shutdownNow();
        remoteWatcher.shutdownNow();
        usbScanner.shutdownNow();
        releasePlayer();
    }
}
