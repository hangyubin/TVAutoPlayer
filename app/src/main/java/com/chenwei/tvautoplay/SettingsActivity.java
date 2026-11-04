package com.chenwei.tvautoplay;

import android.app.AlertDialog;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputFilter;
import android.text.InputType;
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
    private Button terminalPairButton;
    private TextView remoteStatus;
    private TextView terminalStatus;
    private TextView usbStatus;
    private CheckBox autoStart;
    private Button soundButton;
    private Button scaleButton;
    private Button imageDurationButton;
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
        terminalPairButton = findViewById(R.id.terminal_pair_button);
        remoteStatus = findViewById(R.id.remote_status_value);
        terminalStatus = findViewById(R.id.terminal_pair_status_value);
        usbStatus = findViewById(R.id.usb_status_value);
        autoStart = findViewById(R.id.auto_start_checkbox);
        soundButton = findViewById(R.id.sound_button);
        scaleButton = findViewById(R.id.scale_button);
        imageDurationButton = findViewById(R.id.image_duration_button);

        playModeButton.setOnClickListener(view -> togglePlayMode());
        serverUrlButton.setOnClickListener(view -> editServerUrl());
        terminalPairButton.setOnClickListener(view -> startPairing());
        findViewById(R.id.back_to_player_button).setOnClickListener(view -> finish());
        autoStart.setOnClickListener(view ->
                configStore.setAutoStartEnabled(autoStart.isChecked()));
        soundButton.setOnClickListener(view -> toggleSound());
        scaleButton.setOnClickListener(view -> toggleScaleMode());
        imageDurationButton.setOnClickListener(view -> toggleImageDuration());

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

        terminalStatus.setText(configStore.terminalId() > 0
                ? getString(R.string.terminal_paired_status, pairedName())
                : getString(R.string.terminal_not_paired));

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

        if (remote) {
            usbStatus.setVisibility(TextView.GONE);
        } else {
            usbStatus.setVisibility(TextView.VISIBLE);
            refreshUsbStatus();
        }
    }

    private String pairedName() {
        String name = configStore.terminalName();
        return name.isEmpty()
                ? getString(R.string.remote_mode_label_short)
                : name;
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

    private void startPairing() {
        if (configStore.serverUrl().isEmpty()) {
            Toast.makeText(this, R.string.terminal_pair_need_server_url, Toast.LENGTH_LONG).show();
            return;
        }
        final EditText input = new EditText(this);
        input.setHint(R.string.terminal_pair_code_hint);
        input.setInputType(InputType.TYPE_CLASS_NUMBER);
        input.setSingleLine(true);
        input.setFilters(new InputFilter[]{new InputFilter.LengthFilter(6)});
        new AlertDialog.Builder(this)
                .setTitle(R.string.terminal_pair_dialog_title)
                .setView(input)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.save, (dialog, which) -> {
                    String code = input.getText().toString().trim();
                    if (!code.matches("\\d{6}")) {
                        Toast.makeText(
                                this,
                                R.string.terminal_pair_code_invalid,
                                Toast.LENGTH_LONG
                        ).show();
                        return;
                    }
                    submitPairing(code);
                })
                .show();
    }

    private void submitPairing(String code) {
        final String serverUrl = configStore.serverUrl();
        final String deviceName = Build.MODEL == null ? "TV" : Build.MODEL;
        background.execute(() -> {
            try {
                RemoteManifestClient.PairResult result =
                        RemoteManifestClient.claim(serverUrl, code, deviceName);
                configStore.setTerminalId(result.terminalId);
                configStore.setTerminalName(result.name);
                mainHandler.post(() -> {
                    if (destroyed) {
                        return;
                    }
                    setResult(RESULT_OK);
                    Toast.makeText(
                            this,
                            getString(R.string.terminal_pair_success, result.name),
                            Toast.LENGTH_LONG
                    ).show();
                    refreshValues();
                });
            } catch (RemoteManifestClient.FetchException exception) {
                final String message = translatePairingError(exception.getMessage());
                mainHandler.post(() -> {
                    if (destroyed) {
                        return;
                    }
                    Toast.makeText(this, message, Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    private String translatePairingError(String code) {
        if (code == null) {
            return getString(R.string.terminal_pair_failed);
        }
        if (code.startsWith("pair_rejected:")) {
            String detail = code.substring("pair_rejected:".length()).trim();
            return detail.isEmpty()
                    ? getString(R.string.terminal_pair_failed)
                    : getString(R.string.terminal_pair_rejected, detail);
        }
        if (code.startsWith("connect_error:")) {
            return getString(R.string.remote_connect_error,
                    code.substring("connect_error:".length()));
        }
        return getString(R.string.terminal_pair_failed);
    }
}
