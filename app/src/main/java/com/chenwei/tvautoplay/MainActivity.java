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
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import java.util.ArrayList;
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
    private boolean unreadableNoticeShown;
    private int consecutivePlaybackFailures;
    private int activePlaylistSize;
    private String activePlaylistSourceId;
    private boolean activityStarted;
    private ActivityResultLauncher<Intent> settingsLauncher;
    /** Monotonic version of the config last rendered; remote version is pushed here too. */
    private int appliedRemoteVersion;
    private boolean remoteFetchInFlight;

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
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                openSettings(false);
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

        Button chooseMedia = findViewById(R.id.choose_video_button);
        Button openSettings = findViewById(R.id.open_settings_button);
        Button retry = findViewById(R.id.retry_button);
        Button errorSettings = findViewById(R.id.error_settings_button);

        chooseMedia.setOnClickListener(view -> openSettings(true));
        openSettings.setOnClickListener(view -> openSettings(false));
        errorSettings.setOnClickListener(view -> openSettings(false));
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
            openSettings(false);
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
        PlaybackConfiguration configuration = configStore.load();
        renderConfiguration(configuration, null);
    }

    /** Non-blocking; runs on background thread, renders on main. */
    private void fetchAndApplyRemoteManifest(boolean force) {
        if (remoteFetchInFlight) return;
        remoteFetchInFlight = true;
        final String serverUrl = configStore.serverUrl();
        remoteFetcher.execute(() -> {
            PlaybackConfiguration config;
            try {
                RemoteManifestClient.Manifest manifest = new RemoteManifestClient(serverUrl).fetch();
                config = RemoteContentBridge.toLocalConfig(manifest);
                configStore.setRemoteLastFetchMillis(System.currentTimeMillis());
                configStore.setRemoteContentVersion(manifest.contentVersion);
            } catch (RemoteManifestClient.FetchException e) {
                String host = serverUrl.isEmpty()
                        ? getString(R.string.remote_not_set)
                        : serverUrl;
                String detail = translateRemoteError(e.getMessage());
                String msg = getString(R.string.remote_prefix, detail);
                mainHandler.post(() -> renderRemoteError(host + "：" + detail, msg));
                return;
            } finally {
                remoteFetchInFlight = false;
            }
            final PlaybackConfiguration finalConfig = config;
            final int version = manifest != null ? manifest.contentVersion : 0;
            mainHandler.post(() -> {
                if (finalConfig == null) {
                    renderRemoteError(
                            serverUrl.isEmpty()
                                    ? getString(R.string.remote_mode_label_short)
                                    : serverUrl,
                            getString(R.string.remote_empty_manifest));
                    return;
                }
                if (!force && version > 0 && version <= appliedRemoteVersion) {
                    // contentVersion unchanged — keep playing, no re-render
                    return;
                }
                appliedRemoteVersion = version;
                renderConfiguration(finalConfig, "remote:" + version);
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
        List<PlaylistItem> items = effective.playlist();

        // In remote mode we skip UriAccess.readableItems() — every item is an
        // absolute http:// URL that ExoPlayer streams directly, no ContentResolver.
        List<PlaylistItem> playable = configStore.isRemoteModeEnabled()
                ? items
                : UriAccess.readableItems(this, items);
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
            if (!settingsOpen && !selectionPromptAttempted) {
                openSettings(true);
            }
            return;
        }

        if (!configStore.isRemoteModeEnabled()
                && !unreadableNoticeShown
                && playable.size() < effective.playlist().size()) {
            unreadableNoticeShown = true;
            int unreadableCount = effective.playlist().size() - playable.size();
            Toast.makeText(
                    this,
                    getResources().getQuantityString(
                            R.plurals.unreadable_media_skipped,
                            unreadableCount,
                            unreadableCount
                    ),
                    Toast.LENGTH_LONG
            ).show();
        }

        showPlayer();
        releasePlayer();
        consecutivePlaybackFailures = 0;
        activePlaylistSize = playable.size();
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
// Remote mode: also refresh manifest        if (configStore.isRemoteModeEnabled()) {
            fetchAndApplyRemoteManifest(false);
            scheduleHandler.postDelayed(scheduleCheck, SCHEDULE_CHECK_INTERVAL_MS);
            return;
        }
        PlaybackConfiguration configuration = configStore.load();
        ResolvedPlaylist effective = resolveEffectivePlaylist(configuration);
        if (!effective.sourceId().equals(activePlaylistSourceId)) {
            startConfiguredPlayback();
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
        emptyMessage.setText(decision == PlaybackDecision.PERMISSION_REQUIRED
                ? R.string.playlist_permission_lost
                : R.string.no_playlist_selected);
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

    private void openSettings(boolean chooseImmediately) {
        if (settingsOpen) {
            return;
        }
        if (chooseImmediately) {
            selectionPromptAttempted = true;
        }
        settingsOpen = true;
        Intent intent = new Intent(this, SettingsActivity.class)
                .putExtra(SettingsActivity.EXTRA_CHOOSE_IMMEDIATELY, chooseImmediately);
        settingsLauncher.launch(intent);
    }

    private void releasePlayer() {
        if (player != null) {
            playerView.setPlayer(null);
            player.release();
            player = null;
        }
        activePlaylistSize = 0;
        consecutivePlaybackFailures = 0;
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
        releasePlayer();
    }
}
