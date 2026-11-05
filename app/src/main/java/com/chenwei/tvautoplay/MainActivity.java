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
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
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

    private final Handler scheduleHandler = new Handler(Looper.getMainLooper());
    private final Runnable scheduleCheck = this::checkForScheduleTransition;
    private final ExecutorService remoteFetcher = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "RemoteManifest");
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
    private DefaultTrackSelector trackSelector;
    private boolean settingsOpen;
    private boolean selectionPromptAttempted;
    private boolean permissionRequested;
    private boolean usbScanInFlight;
    private int consecutivePlaybackFailures;
    private int activePlaylistSize;
    private String activePlaylistSourceId;
    private boolean activityStarted;
    private ActivityResultLauncher<Intent> settingsLauncher;
    private ActivityResultLauncher<String[]> permissionLauncher;
    /** Monotonic version of the config last rendered; remote version is pushed here too. */
    private int appliedRemoteVersion;
    private boolean remoteFetchInFlight;
    /** Last remote configuration received; used for 30 s schedule-boundary checks. */
    private PlaybackConfiguration lastRemoteConfig;
    private List<PlaylistItem> currentPlayable = new ArrayList<>();

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
            // 0 = 跟随默认音轨
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
                if (!force && version > 0 && version == appliedRemoteVersion && player != null) {
                    // Content hash unchanged and already playing — keep going.
                    return;
                }
                appliedRemoteVersion = version;
                renderConfiguration(config, "remote:" + version);
            });
        });
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
        activePlaylistSourceId = sourceTag != null ? sourceTag : effective.sourceId();
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
        releasePlayer();
        consecutivePlaybackFailures = 0;
        activePlaylistSize = playable.size();
        trackSelector = new DefaultTrackSelector(this);
        player = new ExoPlayer.Builder(this)
                .setTrackSelector(trackSelector)
                .setAudioAttributes(
                        new AudioAttributes.Builder()
                                .setUsage(C.USAGE_MEDIA)
                                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                                .build(),
                        true
                )
                .build();
        player.setRepeatMode(Player.REPEAT_MODE_ALL);
        player.setVolume(configuration.soundEnabled() ? 1f : 0f);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(PlaybackException error) {
                handlePlaybackError(error);
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_READY) {
                    consecutivePlaybackFailures = 0;
                    errorPanel.setVisibility(View.GONE);
                    // 每次新条目就绪后应用用户上次选择的音轨（自动处理跨集、跨源切换）
                    applySavedAudioTrackOverride();
                }
            }
        });

        playerView.setResizeMode(configuration.scaleMode() == ScaleMode.ZOOM
                ? AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                : AspectRatioFrameLayout.RESIZE_MODE_FIT);
        playerView.setPlayer(player);
        List<MediaItem> mediaItems = new ArrayList<>(playable.size());
        for (PlaylistItem item : playable) {
            mediaItems.add(PlaybackMediaItemFactory.create(
                    item,
                    configuration.imageDuration()
            ));
        }
        player.setMediaItems(mediaItems);
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
                if (!effective.sourceId().equals(activePlaylistSourceId)) {
                    renderConfiguration(remoteConfiguration, effective.sourceId());
                }
            }
            fetchAndApplyRemoteManifest(false);
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
        showPlaybackError(error);
    }

    private void openSettings() {
        if (settingsOpen) {
            return;
        }
        settingsOpen = true;
        settingsLauncher.launch(new Intent(this, SettingsActivity.class));
    }

    private void releasePlayer() {
        currentPlayable = new ArrayList<>();
        trackSelector = null;
        if (player != null) {
            playerView.setPlayer(null);
            player.release();
            player = null;
        }
        activePlaylistSize = 0;
        consecutivePlaybackFailures = 0;
    }

    // ---------- 音轨切换（电视遥控器数字键 1-9 选音轨，0 回默认） ----------

    private void selectAudioTrack(int index) {
        if (trackSelector == null || player == null) return;
        Tracks.Group group = firstAudioTrackGroup();
        if (group == null) {
            Toast.makeText(this, R.string.audio_track_none, Toast.LENGTH_SHORT).show();
            return;
        }
        if (index >= group.length) {
            Toast.makeText(this, getString(R.string.audio_track_out_of_range,
                    index + 1, group.length), Toast.LENGTH_SHORT).show();
            return;
        }
        if (!group.isTrackSupported(index)) {
            Toast.makeText(this, getString(R.string.audio_track_not_supported,
                    index + 1), Toast.LENGTH_SHORT).show();
            return;
        }
        trackSelector.setParameters(trackSelector.buildUponParameters()
                .addOverride(new DefaultTrackSelector.SelectionOverride(
                        C.TRACK_TYPE_AUDIO, 0, index))
                .build());
        configStore.setPreferredAudioTrackIndex(index);
        Toast.makeText(this, getString(R.string.audio_track_selected,
                index + 1, group.length), Toast.LENGTH_SHORT).show();
    }

    private void resetAudioTrackToDefault() {
        if (trackSelector == null) return;
        trackSelector.setParameters(trackSelector.buildUponParameters()
                .clearSelectionOverrides().build());
        configStore.setPreferredAudioTrackIndex(-1);
        Toast.makeText(this, getString(R.string.audio_track_selected_default),
                Toast.LENGTH_SHORT).show();
    }

    /** 新 MediaItem 就绪后自动应用上次用户选择的音轨 index；用户没选过则保持默认。 */
    private void applySavedAudioTrackOverride() {
        if (trackSelector == null || player == null) return;
        int saved = configStore.preferredAudioTrackIndex();
        if (saved < 0) return;
        Tracks.Group group = firstAudioTrackGroup();
        if (group == null || saved >= group.length || !group.isTrackSupported(saved)) return;
        // 已生效则不重复写入（避免 onTracksChanged 风暴）
        if (group.isTrackSelected(saved)) return;
        trackSelector.setParameters(trackSelector.buildUponParameters()
                .addOverride(new DefaultTrackSelector.SelectionOverride(
                        C.TRACK_TYPE_AUDIO, 0, saved))
                .build());
    }

    private Tracks.Group firstAudioTrackGroup() {
        Tracks tracks = player.getCurrentTracks();
        List<Tracks.Group> audioGroups = tracks.getGroups(Tracks.GROUP_TYPE_AUDIO);
        for (Tracks.Group g : audioGroups) {
            if (g.length > 0) return g;
        }
        return null;
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
        usbScanner.shutdownNow();
        releasePlayer();
    }
}
