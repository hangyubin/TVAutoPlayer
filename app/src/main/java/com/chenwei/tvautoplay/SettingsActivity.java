package com.chenwei.tvautoplay;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** D-pad-friendly settings screen and the only place that changes the selected document. */
public final class SettingsActivity extends ComponentActivity {
    public static final String EXTRA_CHOOSE_IMMEDIATELY = "choose_immediately";
    private static final String STATE_PICKER_STARTED = "picker_started";
    private static final String STATE_APPEND_SELECTION = "append_selection";

    private PlaybackConfigStore configStore;
    private TextView selectedVideo;
    private CheckBox autoStart;
    private CheckBox remoteMode;
    private Button serverUrlButton;
    private TextView remoteStatus;
    private Button soundButton;
    private Button scaleButton;
    private Button imageDurationButton;
    private TextView scheduleSummary;
    private boolean pickerStarted;
    private boolean appendSelection;
    private ActivityResultLauncher<Intent> videoPickerLauncher;
    private ActivityResultLauncher<Intent> mediaLibraryLauncher;
    private ActivityResultLauncher<Intent> scheduleLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        videoPickerLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> handleVideoPickerResult(result.getResultCode(), result.getData())
        );
        mediaLibraryLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == RESULT_OK) {
                        setResult(RESULT_OK);
                        finish();
                    } else {
                        refreshValues();
                    }
                }
        );
        scheduleLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> refreshValues()
        );
        setContentView(R.layout.activity_settings);
        configStore = new PlaybackConfigStore(this);
        if (savedInstanceState != null) {
            pickerStarted = savedInstanceState.getBoolean(STATE_PICKER_STARTED, false);
            appendSelection = savedInstanceState.getBoolean(STATE_APPEND_SELECTION, false);
        }

        selectedVideo = findViewById(R.id.selected_video_value);
        autoStart = findViewById(R.id.auto_start_checkbox);
        remoteMode = findViewById(R.id.remote_mode_checkbox);
        serverUrlButton = findViewById(R.id.server_url_button);
        remoteStatus = findViewById(R.id.remote_status_value);
        soundButton = findViewById(R.id.sound_button);
        scaleButton = findViewById(R.id.scale_button);
        imageDurationButton = findViewById(R.id.image_duration_button);
        scheduleSummary = findViewById(R.id.schedule_summary_value);

        findViewById(R.id.select_video_button).setOnClickListener(
                view -> openMediaLibrary(false)
        );
        findViewById(R.id.append_video_button).setOnClickListener(
                view -> openMediaLibrary(true)
        );
        Button systemPickerButton = findViewById(R.id.system_picker_button);
        systemPickerButton.setVisibility(canLaunchSystemPicker() ? View.VISIBLE : View.GONE);
        systemPickerButton.setOnClickListener(view -> launchVideoPicker(false));
        findViewById(R.id.clear_video_button).setOnClickListener(view -> confirmClearVideo());
        findViewById(R.id.back_to_player_button).setOnClickListener(view -> finish());
        autoStart.setOnClickListener(view ->
                configStore.setAutoStartEnabled(autoStart.isChecked()));
        remoteMode.setOnClickListener(view -> {
            if (remoteMode.isChecked() && configStore.serverUrl().isEmpty()) {
                Toast.makeText(this, R.string.remote_mode_need_server_url, Toast.LENGTH_LONG).show();
                remoteMode.setChecked(false);
                return;
            }
            configStore.setRemoteModeEnabled(remoteMode.isChecked());
            refreshValues();
        });
        serverUrlButton.setOnClickListener(view -> editServerUrl());
        soundButton.setOnClickListener(view -> toggleSound());
        scaleButton.setOnClickListener(view -> toggleScaleMode());
        imageDurationButton.setOnClickListener(view -> toggleImageDuration());
        findViewById(R.id.schedule_settings_button).setOnClickListener(
                view -> scheduleLauncher.launch(new Intent(this, ScheduleActivity.class))
        );

        refreshValues();
        boolean chooseImmediately = getIntent().getBooleanExtra(EXTRA_CHOOSE_IMMEDIATELY, false);
        if (chooseImmediately && savedInstanceState == null) {
            selectedVideo.post(() -> openMediaLibrary(false));
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        outState.putBoolean(STATE_PICKER_STARTED, pickerStarted);
        outState.putBoolean(STATE_APPEND_SELECTION, appendSelection);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshValues();
    }

    private void handleVideoPickerResult(int resultCode, Intent data) {
        pickerStarted = false;
        if (resultCode != RESULT_OK || data == null) {
            return;
        }

        List<Uri> selectedUris = selectedUris(data);
        if (selectedUris.isEmpty()) {
            Toast.makeText(this, R.string.invalid_media_selection, Toast.LENGTH_LONG).show();
            return;
        }

        if ((data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) {
            Toast.makeText(this, R.string.persist_permission_failed, Toast.LENGTH_LONG).show();
            return;
        }
        List<PlaylistItem> selectedItems = new ArrayList<>();
        int failedCount = 0;
        for (Uri uri : selectedUris) {
            try {
                getContentResolver().takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
                if (UriAccess.canRead(this, uri.toString())) {
                    String displayName = UriAccess.displayName(this, uri);
                    MediaKind kind = UriAccess.mediaKind(this, uri, displayName);
                    if (kind != null) {
                        selectedItems.add(new PlaylistItem(
                                uri.toString(),
                                displayName,
                                kind
                        ));
                    } else {
                        failedCount++;
                        UriAccess.releasePersistedReadPermission(this, uri.toString());
                    }
                } else {
                    failedCount++;
                    UriAccess.releasePersistedReadPermission(this, uri.toString());
                }
            } catch (SecurityException exception) {
                failedCount++;
            }
        }

        if (selectedItems.isEmpty()) {
            Toast.makeText(this, R.string.persist_permission_failed, Toast.LENGTH_LONG).show();
            return;
        }

        PlaybackConfiguration current = configStore.load();
        List<PlaylistItem> updated = appendSelection
                ? PlaylistEditor.append(current.playlist(), selectedItems)
                : PlaylistEditor.replace(selectedItems);
        if (!appendSelection) {
            UriAccess.releaseRemovedPersistedReadPermissions(this, current.playlist(), updated);
        }
        configStore.savePlaylist(updated);
        if (failedCount > 0) {
            Toast.makeText(
                    this,
                    getString(R.string.playlist_selection_partial, selectedItems.size(), failedCount),
                    Toast.LENGTH_LONG
            ).show();
        }
        setResult(RESULT_OK);
        finish();
    }

    private void openMediaLibrary(boolean append) {
        Intent intent = new Intent(this, MediaLibraryActivity.class)
                .putExtra(MediaLibraryActivity.EXTRA_APPEND_SELECTION, append);
        mediaLibraryLauncher.launch(intent);
    }

    private void launchVideoPicker(boolean append) {
        if (pickerStarted) {
            return;
        }
        pickerStarted = true;
        appendSelection = append;
        Intent intent = createVideoPickerIntent();
        try {
            videoPickerLauncher.launch(intent);
        } catch (RuntimeException exception) {
            pickerStarted = false;
            Toast.makeText(this, R.string.file_picker_unavailable, Toast.LENGTH_LONG).show();
        }
    }

    private boolean canLaunchSystemPicker() {
        return createVideoPickerIntent().resolveActivity(getPackageManager()) != null;
    }

    private Intent createVideoPickerIntent() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "image/*",
                "video/*",
                "application/x-matroska",
                "application/vnd.apple.mpegurl",
                "application/x-mpegURL"
        });
        return intent;
    }

    private void toggleSound() {
        PlaybackConfiguration current = configStore.load();
        configStore.setSoundEnabled(!current.soundEnabled());
        refreshValues();
    }

    private void toggleScaleMode() {
        PlaybackConfiguration current = configStore.load();
        configStore.setScaleMode(current.scaleMode() == ScaleMode.FIT
                ? ScaleMode.ZOOM
                : ScaleMode.FIT);
        refreshValues();
    }

    private void toggleImageDuration() {
        PlaybackConfiguration current = configStore.load();
        configStore.setImageDuration(current.imageDuration().next());
        refreshValues();
    }

    private void confirmClearVideo() {
        if (!configStore.load().hasMedia()) {
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.clear_playlist_title)
                .setMessage(R.string.clear_playlist_message)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.clear, (dialog, which) -> clearVideo())
                .show();
    }

    private void clearVideo() {
        List<PlaylistItem> previousItems = configStore.load().playlist();
        configStore.clearPlaylist();
        for (PlaylistItem item : previousItems) {
            UriAccess.releasePersistedReadPermission(this, item.uri());
        }
        refreshValues();
    }

    private void refreshValues() {
        PlaybackConfiguration configuration = configStore.load();
        selectedVideo.setText(configuration.hasMedia()
                ? formatPlaylist(configuration.playlist())
                : getString(R.string.not_selected));
        autoStart.setChecked(configuration.autoStartEnabled());
        remoteMode.setChecked(configStore.isRemoteModeEnabled());
        String url = configStore.serverUrl();
        serverUrlButton.setText(url.isEmpty()
                ? getString(R.string.server_url_default)
                : getString(R.string.server_url_value, url));
        if (configStore.isRemoteModeEnabled()) {
            int v = configStore.remoteContentVersion();
            if (v > 0) {
                long last = System.currentTimeMillis() - configStore.remoteLastFetchMillis();
                String ago = formatElapsed(last);
                remoteStatus.setText(getString(R.string.remote_status_connected, v, ago));
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
        scheduleSummary.setText(configuration.scheduledPlaylists().isEmpty()
                ? getString(R.string.schedule_settings_empty)
                : getString(
                        R.string.schedule_settings_summary,
                        getResources().getQuantityString(
                                R.plurals.schedule_count,
                                configuration.scheduledPlaylists().size(),
                                configuration.scheduledPlaylists().size()
                        ),
                        getString(configuration.scheduleEnabled()
                                ? R.string.schedule_master_on
                                : R.string.schedule_master_off)
                ));
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
                        // Clear remote mode when the address is cleared
                        configStore.setRemoteModeEnabled(false);
                    } else {
                        configStore.setServerUrl(raw);
                    }
                    refreshValues();
                })
                .show();
    }

    private String formatPlaylist(List<PlaylistItem> playlist) {
        StringBuilder value = new StringBuilder(
                getString(R.string.selected_video_count, playlist.size())
        );
        for (int index = 0; index < playlist.size(); index++) {
            value.append('\n')
                    .append(index + 1)
                    .append(". ")
                    .append(getString(playlist.get(index).kind() == MediaKind.IMAGE
                            ? R.string.media_kind_image_short
                            : R.string.media_kind_video_short))
                    .append(' ')
                    .append(playlist.get(index).displayName());
        }
        return value.toString();
    }

    private List<Uri> selectedUris(Intent data) {
        Set<String> uniqueValues = new LinkedHashSet<>();
        List<Uri> uris = new ArrayList<>();
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index++) {
                addUri(uris, uniqueValues, clipData.getItemAt(index).getUri());
            }
        } else {
            addUri(uris, uniqueValues, data.getData());
        }
        return uris;
    }

    private void addUri(List<Uri> uris, Set<String> uniqueValues, Uri uri) {
        if (uri != null && uniqueValues.add(uri.toString())) {
            uris.add(uri);
        }
    }
}
