package com.chenwei.tvautoplay;

import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** D-pad-friendly settings screen for the two playback modes: CMS server and USB drive. */
public final class SettingsActivity extends ComponentActivity {
    private final ExecutorService background = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "SettingsBackground");
        thread.setDaemon(true);
        return thread;
    });
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private PlaybackConfigStore configStore;
    private Button playModeButton;
    private Button serverUrlButton;
    private TextView remoteStatus;
    private TextView usbStatus;
    private CheckBox autoStart;
    private Button soundButton;
    private Button scaleButton;
    private Button imageDurationButton;
    private Button audioTrackButton;
    private ActivityResultLauncher<String[]> permissionLauncher;
    private boolean destroyed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        permissionLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestMultiplePermissions(),
                result -> refreshValues()
        );
        setContentView(R.layout.activity_settings);
        configStore = new PlaybackConfigStore(this);

        playModeButton = findViewById(R.id.play_mode_button);
        serverUrlButton = findViewById(R.id.server_url_button);
        remoteStatus = findViewById(R.id.remote_status_value);
        usbStatus = findViewById(R.id.usb_status_value);
        autoStart = findViewById(R.id.auto_start_checkbox);
        soundButton = findViewById(R.id.sound_button);
        scaleButton = findViewById(R.id.scale_button);
        imageDurationButton = findViewById(R.id.image_duration_button);
        audioTrackButton = findViewById(R.id.audio_track_button);

        playModeButton.setOnClickListener(view -> togglePlayMode());
        serverUrlButton.setOnClickListener(view -> editServerUrl());
        findViewById(R.id.back_to_player_button).setOnClickListener(view -> finish());
        autoStart.setOnClickListener(view ->
                configStore.setAutoStartEnabled(autoStart.isChecked()));
        soundButton.setOnClickListener(view -> toggleSound());
        scaleButton.setOnClickListener(view -> toggleScaleMode());
        imageDurationButton.setOnClickListener(view -> toggleImageDuration());
        audioTrackButton.setOnClickListener(view -> pickAudioTrack());

        refreshValues();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshValues();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        background.shutdownNow();
        super.onDestroy();
    }

    private void togglePlayMode() {
        if (configStore.isRemoteModeEnabled()) {
            configStore.setRemoteModeEnabled(false);
            ensureMediaPermission();
        } else {
            if (configStore.serverUrl().isEmpty()) {
                Toast.makeText(this, R.string.play_mode_need_server_url, Toast.LENGTH_LONG).show();
                return;
            }
            configStore.setRemoteModeEnabled(true);
        }
        setResult(RESULT_OK);
        refreshValues();
    }

    private void ensureMediaPermission() {
        if (!MediaPermissionHelper.hasReadAccess(this)) {
            permissionLauncher.launch(MediaPermissionHelper.requiredPermissions());
        }
    }

    private void toggleSound() {
        PlaybackConfiguration current = configStore.load();
        configStore.setSoundEnabled(!current.soundEnabled());
        setResult(RESULT_OK);
        refreshValues();
    }

    private void toggleScaleMode() {
        PlaybackConfiguration current = configStore.load();
        configStore.setScaleMode(current.scaleMode() == ScaleMode.FIT
                ? ScaleMode.ZOOM
                : ScaleMode.FIT);
        setResult(RESULT_OK);
        refreshValues();
    }

    private void toggleImageDuration() {
        PlaybackConfiguration current = configStore.load();
        configStore.setImageDuration(current.imageDuration().next());
        setResult(RESULT_OK);
        refreshValues();
    }

    private void refreshValues() {
        PlaybackConfiguration configuration = configStore.load();
        boolean remote = configStore.isRemoteModeEnabled();

        playModeButton.setText(remote ? R.string.play_mode_server : R.string.play_mode_usb);
        autoStart.setChecked(configuration.autoStartEnabled());

        String url = configStore.serverUrl();
        serverUrlButton.setText(url.isEmpty()
                ? getString(R.string.server_url_default)
                : getString(R.string.server_url_value, url));

        if (remote) {
            int version = configStore.remoteContentVersion();
            if (version > 0) {
                long last = System.currentTimeMillis() - configStore.remoteLastFetchMillis();
                remoteStatus.setText(getString(
                        R.string.remote_status_connected, version, formatElapsed(last)));
            } else {
                remoteStatus.setText(R.string.remote_status_disconnected);
            }
        } else {
            remoteStatus.setText(R.string.remote_status_local);
        }

        soundButton.setText(configuration.soundEnabled()
                ? R.string.sound_on
                : R.string.sound_off);
        scaleButton.setText(configuration.scaleMode() == ScaleMode.FIT
                ? R.string.scale_fit
                : R.string.scale_zoom);
        imageDurationButton.setText(getString(
                R.string.image_duration_value,
                configuration.imageDuration().seconds()
        ));

        int savedTrack = configStore.preferredAudioTrackIndex();
        if (savedTrack < 0) {
            audioTrackButton.setText(R.string.audio_track_default);
        } else {
            audioTrackButton.setText(getString(
                    R.string.audio_track_button_value, savedTrack + 1));
        }

        if (remote) {
            usbStatus.setVisibility(TextView.GONE);
        } else {
            usbStatus.setVisibility(TextView.VISIBLE);
            refreshUsbStatus();
        }
    }

    private void refreshUsbStatus() {
        if (!MediaPermissionHelper.hasReadAccess(this)) {
            usbStatus.setText(R.string.media_permission_required);
            return;
        }
        usbStatus.setText(R.string.usb_scanning);
        background.execute(() -> {
            List<PlaylistItem> items = UsbMediaScanner.scan(this);
            mainHandler.post(() -> {
                if (destroyed) {
                    return;
                }
                usbStatus.setText(items.isEmpty()
                        ? getString(R.string.usb_status_empty)
                        : getString(R.string.usb_status_value, items.size()));
            });
        });
    }

    private String formatElapsed(long ms) {
        long s = ms / 1000;
        if (s < 5) return getString(R.string.remote_relative_time_just_now);
        if (s < 60) return getString(R.string.remote_relative_time_seconds, s);
        long m = s / 60;
        if (m < 60) return getString(R.string.remote_relative_time_minutes, m);
        long h = m / 60;
        return getString(R.string.remote_relative_time_hours, h);
    }

    private void editServerUrl() {
        final EditText input = new EditText(this);
        input.setHint(R.string.server_url_hint);
        input.setText(configStore.serverUrl());
        input.setSingleLine(true);
        new AlertDialog.Builder(this)
                .setTitle(R.string.server_url_dialog_title)
                .setView(input)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.save, (dialog, which) -> {
                    String raw = input.getText().toString().trim();
                    if (raw.isEmpty()) {
                        configStore.setServerUrl("");
                        configStore.setRemoteModeEnabled(false);
                    } else {
                        configStore.setServerUrl(raw);
                    }
                    setResult(RESULT_OK);
                    refreshValues();
                })
                .show();
    }

    private void pickAudioTrack() {
        int saved = configStore.preferredAudioTrackIndex();
        int maxTrack = 9;
        String[] labels = new String[maxTrack + 1];
        labels[0] = getString(R.string.audio_track_option_default);
        int checkedIndex = 0;
        for (int i = 0; i < maxTrack; i++) {
            labels[i + 1] = getString(R.string.audio_track_option_n, i + 1);
            if (saved == i) checkedIndex = i + 1;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.audio_track_dialog_title)
                .setSingleChoiceItems(labels, checkedIndex, (dialog, which) -> {
                    int index = which - 1; // -1 = default, 0..8 = track 1..9
                    configStore.setPreferredAudioTrackIndex(index);
                    setResult(RESULT_OK);
                    refreshValues();
                    dialog.dismiss();
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

}
