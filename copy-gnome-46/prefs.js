import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { loadConfig, saveConfig, configStatus } from './core/config.js';
import { pasteKeybindingsValue } from './core/prefs-validation.js';
import { Paths } from './core/paths.js';
import { log } from './core/log.js';

// Preferences window (Adw/Gtk4). Runs in a SEPARATE process from gnome-shell (opened by
// Extension Manager's gear or `gnome-extensions prefs copy-gnome@clipboard`), so a crash here
// never touches the compositor. Keybindings write GSettings; General/History write the active
// config file (config.yaml if present, else config.json) via core/config.js saveConfig.

const PERSIST_DEBOUNCE_MS = 300;

export default class CopyGnomePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings();
        this._paths = new Paths().resolve();
        this._config = loadConfig(this._paths.config, { quiet: true });
        this._captureCleanup = null;
        this._persistSource = 0;

        window.set_title('Copy GNOME');
        window.set_default_size(600, 800);
        window.set_search_enabled(true);

        // Flush any debounced write + tear down any in-progress key capture on close.
        window.connect('close-request', () => {
            this._flushNow();
            return false;
        });

        window.add(this._keybindingsPage());
        window.add(this._historyPage());
        window.add(this._storagePage());
        window.add(this._uiPage());
        window.add(this._generalPage());
    }

    // Debounced write of the whole merged config to the active config file. Coalesces rapid edits
    // (spin scrubbing, fast toggles) into one serialize + synchronous write (fine: prefs is
    // out-of-process).
    _persist() {
        if (this._persistSource)
            GLib.Source.remove(this._persistSource);
        this._persistSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PERSIST_DEBOUNCE_MS, () => {
            this._persistSource = 0;
            this._doPersist();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushNow() {
        if (this._persistSource) {
            GLib.Source.remove(this._persistSource);
            this._persistSource = 0;
            this._doPersist();
        }
        if (this._captureCleanup)
            this._captureCleanup();
    }

    _doPersist() {
        const r = saveConfig(this._paths.config, this._config);
        if (r.ok)
            return;
        log.warn(`prefs: config save failed: ${r.error}`);
        // fail-closed: reload from disk so this._config reflects what's actually persisted
        // (the change was NOT saved), then tell the user explicitly.
        try {
            this._config = loadConfig(this._paths.config, { quiet: true });
        } catch (e) {
            log.warn(`prefs: config reload after failed save: ${e.message}`);
        }
        this._showError('Failed to save config',
            `Your change was NOT written to disk and was reverted in memory: ${r.error}`);
    }

    _showError(heading, body) {
        try {
            if (Adw.AlertDialog) {
                const dlg = new Adw.AlertDialog({ heading, body });
                dlg.add_response('ok', 'OK');
                dlg.connect('response', () => dlg.close());
                dlg.present(this._window ?? null);
                return;
            }
            const dlg = new Adw.MessageDialog({ heading, body });
            dlg.add_response('ok', 'OK');
            dlg.connect('response', () => dlg.destroy());
            if (this._window)
                dlg.set_transient_for(this._window);
            dlg.present();
        } catch (e) {
            log.warn(`prefs: error dialog failed: ${e.message}`);
        }
    }

    // ---------- Keybindings (GSettings) ----------
    _keybindingsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Keybindings', icon_name: 'input-keyboard-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Keybindings',
            description: 'Press Set, then the keys. Backspace clears; Esc cancels.',
        });
        for (const row of this._keybindingRows('toggle-popup',
            'Open clipboard popup',
            'Opens the centered, searchable history list.'))
            group.add(row);
        page.add(group);
        return page;
    }

    _keybindingRows(key, title, description) {
        const row = new Adw.ActionRow({ title });
        const detailRow = new Adw.ActionRow({
            title: description,
            subtitle: this._displayText(this._settingsCommand(key)),
        });
        detailRow.subtitle_lines = 2;
        detailRow.add_suffix(this._copyButton(() =>
            [description, this._settingsCommand(key)].join('\n')));

        const accelLabel = new Gtk.Label({ label: this._readableAccel(key), visible: true });
        accelLabel.add_css_class('dim-label');
        row.add_suffix(accelLabel);

        const setBtn = new Gtk.Button({ label: 'Set', valign: Gtk.Align.CENTER, visible: true });
        setBtn.connect('clicked', () => {
            accelLabel.label = 'Press keys...  (Esc cancels)';
            this._captureKeybinding(key, () => {
                accelLabel.label = this._readableAccel(key);
                detailRow.subtitle = this._displayText(this._settingsCommand(key));
            });
        });
        row.add_suffix(setBtn);

        const clearBtn = new Gtk.Button({ label: 'Clear', valign: Gtk.Align.CENTER, visible: true });
        clearBtn.connect('clicked', () => {
            this._settings.set_strv(key, []);
            accelLabel.label = this._readableAccel(key);
            detailRow.subtitle = this._displayText(this._settingsCommand(key));
        });
        row.add_suffix(clearBtn);

        return [row, detailRow];
    }

    _readableAccel(key) {
        const arr = this._settings.get_strv(key);
        if (!arr || arr.length === 0)
            return 'Disabled';
        // Stored as accelerator_name ("<Super>v", lowercase key - the GNOME standard; the schema
        // default is lowercase too). Display via accelerator_get_label, which uppercases and
        // localizes (e.g. "<Super>v" -> "Super+V").
        return arr.map(a => {
            const [ok, keyval, mods] = Gtk.accelerator_parse(a);
            return !ok || keyval === 0 ? a : Gtk.accelerator_get_label(keyval, mods);
        }).join(', ');
    }

    _configSubtitle(section, field, description = '') {
        return [description, this._configLine(section, field)].filter(Boolean).join('\n');
    }

    _configRow(section, field, title, description = '') {
        const subtitle = this._configSubtitle(section, field, description);
        const row = new Adw.ActionRow({ title, subtitle: this._displayText(subtitle) });
        row.subtitle_lines = 2;
        row.add_suffix(this._copyButton(() => this._configCopyText(section, field, title, description)));
        return row;
    }

    _configCopyText(section, field, title, description = '') {
        return this._configSubtitle(section, field, description);
    }

    _configLine(section, field) {
        return `${section}.${field}: ${this._formatValue(this._config[section][field])}`;
    }

    _settingsCommand(field) {
        const value = this._settings.get_strv(field);
        const schemaDir = GLib.build_filenamev([this.path, 'schemas']);
        return `GSETTINGS_SCHEMA_DIR=${this._shellQuote(schemaDir)} gsettings set org.gnome.shell.extensions.copy-gnome ${field} ${this._shellQuote(JSON.stringify(value))}`;
    }

    _formatValue(value) {
        if (typeof value === 'string')
            return JSON.stringify(value);
        if (Array.isArray(value) || (value && typeof value === 'object'))
            return JSON.stringify(value);
        return String(value);
    }

    _shellQuote(value) {
        return `'${String(value).replace(/'/g, `'\\''`)}'`;
    }

    _displayText(value) {
        return GLib.markup_escape_text(String(value), -1);
    }

    _copyButton(getText) {
        const btn = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy setting info',
            valign: Gtk.Align.CENTER,
            visible: true,
        });
        btn.add_css_class('flat');
        btn.connect('clicked', () => this._copyText(getText()));
        return btn;
    }

    _copyText(text) {
        try {
            const display = Gdk.Display.get_default();
            const clipboard = display?.get_clipboard();
            if (typeof clipboard?.set_text === 'function')
                clipboard.set_text(String(text));
            else if (typeof clipboard?.set === 'function')
                clipboard.set(String(text));
            else
                throw new Error('clipboard API unavailable');
        } catch (e) {
            log.warn(`prefs: copy failed: ${e.message}`);
        }
    }

    // Grab the next key combo on the preferences window. Esc cancels; Backspace clears. Cancels
    // any in-progress capture first so two Set clicks (or Set then no key) can never stack two
    // controllers on the window or double-fire the binding.
    _captureKeybinding(key, onChange) {
        if (this._captureCleanup)
            this._captureCleanup();

        const controller = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        let finished = false;
        let sid = 0;

        const cleanup = () => {
            if (finished) return;
            finished = true;
            try { if (sid) controller.disconnect(sid); } catch (e) {}
            try { this._window.remove_controller(controller); } catch (e) {}
            if (this._captureCleanup === cleanup)
                this._captureCleanup = null;
        };
        this._captureCleanup = cleanup;

        sid = controller.connect('key-pressed', (_c, keyval, _kc, state) => {
            if (finished) return true;
            const mask = state & Gtk.accelerator_get_default_mod_mask();

            if (keyval === Gdk.KEY_Escape) {
                cleanup();
                onChange();
                return true;
            }
            if (keyval === Gdk.KEY_BackSpace) {
                this._settings.set_strv(key, []);
                cleanup();
                onChange();
                return true;
            }
            if (!Gtk.accelerator_valid(keyval, mask))
                return false;   // ignore bare keys; require a real combo (modifier+key)
            this._settings.set_strv(key, [Gtk.accelerator_name(keyval, mask)]);
            cleanup();
            onChange();
            return true;
        });

        this._window.add_controller(controller);
    }

    // ---------- General ----------
    _generalPage() {
        const page = new Adw.PreferencesPage({
            title: 'General', icon_name: 'preferences-system-symbolic',
        });
        const group = new Adw.PreferencesGroup({ title: 'Capture' });

        group.add(this._boolRow('captureFiles', 'Capture copied files',
            'Stored as URI/path references only; no file bytes are kept.',
            'general'));
        group.add(this._boolRow('captureImages', 'Capture images / screenshots',
            'Risky inside GNOME Shell - can destabilize the compositor. Turn off if the session gets unstable.',
            'general'));

        page.add(group);

        const logGroup = new Adw.PreferencesGroup({ title: 'Log' });
        logGroup.add(this._enumRow('level', 'Log level',
            'Changes take effect the next time the extension reloads config.',
            'logging', ['error', 'warn', 'info', 'debug']));
        logGroup.add(this._infoRow('Journal command',
            'journalctl --user | grep -i copy-gnome'));
        page.add(logGroup);

        const privacyGroup = new Adw.PreferencesGroup({
            title: 'Privacy',
            description: 'Selections advertising these MIME types are skipped.',
        });
        privacyGroup.add(this._listRow('secretMimes', 'Secret MIME types',
            'Comma-separated MIME names.', 'privacy'));
        page.add(privacyGroup);

        this._addAboutGroups(page);

        return page;
    }

    _boolRow(field, title, subtitle, section) {
        const row = this._configRow(section, field, title, subtitle);
        const sw = new Gtk.Switch({
            active: !!this._config[section][field],
            valign: Gtk.Align.CENTER,
            visible: true,
        });
        sw.connect('notify::active', () => {
            this._config[section][field] = sw.active;
            row.subtitle = this._displayText(this._configSubtitle(section, field, subtitle));
            this._persist();
        });
        row.add_suffix(sw);
        row.activatable_widget = sw;
        return row;
    }

    // ---------- History ----------
    _historyPage() {
        const page = new Adw.PreferencesPage({
            title: 'History', icon_name: 'view-list-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Limits',
            description: 'Default 500 items x 4 MiB. Each item can be up to 16 MiB. If a snapshot reaches the internal 64 MiB cap, oldest entries are trimmed.',
        });

        group.add(this._spinRow('maxItems', 'Max history items', 1, 1000, 1,
            'history', v => v, v => Math.round(v),
            'Maximum entries kept in memory and shown in the popup.'));
        group.add(this._spinRow('maxItemBytes', 'Max item size (KiB)', 1, 16384, 1,
            'history', v => Math.round(v / 1024), v => Math.round(v) * 1024,
            'Oversized single items are skipped.'));
        group.add(this._spinRow('maxAgeDays', 'Expire files after days (0 = never)', 0, 3650, 1,
            'history', v => v, v => Math.round(v),
            '0 keeps all daily clips files; N deletes clips-*.jsonl files older than N days.'));
        group.add(this._spinRow('cleanupIntervalSec', 'Cleanup interval (seconds)', 15, 864000, 60,
            'history', v => v, v => Math.round(v),
            'How often to sweep expired files. Default 86400 (24h).'));

        page.add(group);
        return page;
    }

    _spinRow(field, title, min, max, step, section, toSpin, fromSpin, subtitle = '') {
        const row = this._configRow(section, field, title, subtitle);
        const spin = Gtk.SpinButton.new_with_range(min, max, step);
        spin.value = toSpin(this._config[section][field]);
        spin.valign = Gtk.Align.CENTER;
        spin.visible = true;
        spin.connect('value-changed', () => {
            this._config[section][field] = fromSpin(spin.value);
            row.subtitle = this._displayText(this._configSubtitle(section, field, subtitle));
            this._persist();
        });
        row.add_suffix(spin);
        return row;
    }

    _listRow(field, title, subtitle, section) {
        const row = this._configRow(section, field, title, subtitle);
        const entry = new Gtk.Entry({
            text: (this._config[section][field] ?? []).join(', '),
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_chars: 48,
        });
        entry.connect('notify::text', () => {
            this._config[section][field] = entry.text
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            row.subtitle = this._displayText(this._configSubtitle(section, field, subtitle));
            this._persist();
        });
        row.add_suffix(entry);
        row.activatable_widget = entry;
        return row;
    }

    _jsonRow(field, title, subtitle, section, validate = value => ({ ok: true, value })) {
        const row = this._configRow(section, field, title, subtitle);
        const entry = new Gtk.Entry({
            text: JSON.stringify(this._config[section][field] ?? []),
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_chars: 56,
        });
        entry.connect('notify::text', () => {
            let parsed;
            try {
                parsed = JSON.parse(entry.text);
            } catch (e) {
                entry.tooltip_text = e.message;
                entry.add_css_class('error');
                return;
            }
            const r = validate(parsed);
            if (!r.ok) {
                log.warn(`prefs: invalid ${section}.${field}: ${r.error}`);
                entry.tooltip_text = r.error;
                entry.add_css_class('error');
                return;
            }
            this._config[section][field] = r.value;
            row.subtitle = this._displayText(this._configSubtitle(section, field, subtitle));
            entry.tooltip_text = null;
            entry.remove_css_class('error');
            this._persist();
        });
        row.add_suffix(entry);
        row.activatable_widget = entry;
        return row;
    }

    _enumRow(field, title, subtitle, section, values) {
        const row = this._configRow(section, field, title, subtitle);
        const dropdown = Gtk.DropDown.new_from_strings(values);
        const current = this._config[section][field];
        dropdown.selected = Math.max(0, values.indexOf(current));
        dropdown.valign = Gtk.Align.CENTER;
        dropdown.connect('notify::selected', () => {
            this._config[section][field] = values[dropdown.selected] ?? values[0];
            row.subtitle = this._displayText(this._configSubtitle(section, field, subtitle));
            this._persist();
        });
        row.add_suffix(dropdown);
        row.activatable_widget = dropdown;
        return row;
    }

    // ---------- Storage ----------
    _storagePage() {
        const page = new Adw.PreferencesPage({
            title: 'Storage', icon_name: 'drive-harddisk-symbolic',
        });

        const capture = new Adw.PreferencesGroup({
            title: 'Capture Caps',
            description: 'Oversized items are skipped instead of persisted.',
        });
        capture.add(this._spinRow('textMaxBytes', 'Text payload cap (KiB)', 0, 15360, 1,
            'storage', v => Math.round(v / 1024), v => Math.round(v) * 1024,
            'Text stored inside the JSONL snapshot; larger text is skipped.'));
        capture.add(this._spinRow('binaryMaxBytes', 'Image/binary payload cap (KiB)', 0, 10240, 1,
            'storage', v => Math.round(v / 1024), v => Math.round(v) * 1024,
            'Non-file image/binary payload stored in JSONL; larger payloads are skipped.'));
        page.add(capture);

        const persistence = new Adw.PreferencesGroup({
            title: 'Persistence',
            description: 'Advanced JSONL persistence knobs; leave defaults unless debugging.',
        });
        persistence.add(this._spinRow('flushIntervalSec', 'Flush interval (sec, 5-28800)', 5, 28800, 1,
            'storage', v => v, v => Math.round(v),
            'Append the latest history snapshot once per N seconds. The only disk writer.'));
        page.add(persistence);

        return page;
    }

    // ---------- UI ----------
    _uiPage() {
        const page = new Adw.PreferencesPage({
            title: 'UI', icon_name: 'preferences-desktop-symbolic',
        });

        const win = new Adw.PreferencesGroup({ title: 'Window' });
        win.add(this._spinRow('popupWidth', 'Width (px)', 240, 8000, 10,
            'ui', v => v, v => Math.round(v),
            'Popup target width; shrinks on small monitors.'));
        win.add(this._spinRow('popupMaxHeight', 'Max height (px)', 120, 8000, 10,
            'ui', v => v, v => Math.round(v),
            'Popup maximum height; content scrolls when needed.'));
        win.add(this._spinRow('popupOffsetX', 'Offset X (px)', -1000, 1000, 10,
            'ui', v => v, v => Math.round(v),
            'Horizontal adjustment from the default placement.'));
        win.add(this._spinRow('popupOffsetY', 'Offset Y (px)', -1000, 1000, 10,
            'ui', v => v, v => Math.round(v),
            'Vertical adjustment from the default placement.'));
        win.add(this._spinRow('popupEdgeMargin', 'Edge margin (px)', 0, 96, 1,
            'ui', v => v, v => Math.round(v),
            'Minimum distance from the monitor edge.'));
        win.add(this._spinRow('popupOpacity', 'Opacity (%)', 10, 100, 1,
            'ui', v => Math.round(v * 100), v => v / 100,
            'Whole popup panel opacity.'));
        win.add(this._enumRow('popupTheme', 'Theme', 'Popup color theme.', 'ui',
            ['auto', 'dark', 'light']));
        page.add(win);

        const beh = new Adw.PreferencesGroup({ title: 'Behavior' });
        const autoPasteRow = this._boolRow('autoPaste', 'Auto-paste after restore',
            'After restore, also inject the configured paste keys. Off = restore the clipboard only.', 'ui');
        const delayRow = this._spinRow('autoPasteDelayMs', 'Auto-paste delay (ms)', 0, 5000, 1,
            'ui', v => v, v => Math.round(v),
            'Delay before injecting the paste key after restoring the clipboard.');
        const skipRecentTopRow = this._spinRow('skipClipboardWriteForRecentTopSec', 'Skip clipboard write for recent top (s)', 0, 900, 1,
            'ui', v => v, v => Math.round(v),
            'When row 1 was just updated, restore it without rewriting the system clipboard. 0 disables.');
        beh.add(autoPasteRow);
        beh.add(delayRow);
        beh.add(skipRecentTopRow);
        beh.add(this._spinRow('numberPickTimeoutMs', 'Number-pick timeout (ms)', 100, 5000, 1,
            'ui', v => v, v => Math.round(v),
            'Wait time for multi-digit row numbers, such as 1 vs 11.'));
        beh.add(this._boolRow('pasteRestoresFocus', 'Restore focus before auto-paste',
            'Activate the original window before injecting the paste key.', 'ui'));
        page.add(beh);

        // Disable the delay control when auto-paste is off (the value has no effect then).
        const apSwitch = autoPasteRow.activatable_widget;
        if (apSwitch) {
            const syncDelay = () => delayRow.set_sensitive(apSwitch.active);
            apSwitch.connect('notify::active', syncDelay);
            syncDelay();
        }

        const paste = new Adw.PreferencesGroup({
            title: 'Paste Matching',
            description: 'Paste keys are matched by focused window wm_class.',
        });
        paste.add(this._listRow('fileApps', 'File-target apps',
            'wm_class substrings that receive copied files as text/uri-list; others receive paths.',
            'ui'));
        paste.add(this._listRow('richTextApps', 'Rich-text apps',
            'wm_class substrings that receive HTML when restoring rich-text records.',
            'ui'));
        paste.add(this._listRow('plainTextApps', 'Plain-text apps',
            'wm_class substrings that always receive plain text for rich-text records.',
            'ui'));
        paste.add(this._listRow('defaultPasteKeys', 'Default paste keys',
            'Comma-separated key tokens, such as ctrl, v. Empty restores clipboard only.',
            'ui'));
        paste.add(this._jsonRow('pasteKeybindings', 'Paste keybindings',
            'JSON array: [{"keys":["ctrl","shift","v"],"apps":["terminal"]}]',
            'ui', value => pasteKeybindingsValue(value)));
        page.add(paste);

        return page;
    }

    // ---------- About (read-only) ----------
    _addAboutGroups(page) {
        const group = new Adw.PreferencesGroup({ title: 'Copy GNOME' });

        const md = this._readMetadataFile();
        const shellVer = Array.isArray(md['shell-version'])
            ? md['shell-version'].join('.')
            : (md['shell-version'] ?? '?');
        group.add(this._infoRow('Version', md['version-name'] ?? '?'));
        group.add(this._infoRow('UUID', md.uuid ?? '?'));
        group.add(this._infoRow('GNOME Shell', shellVer));
        // NOTE: paths are resolved by THIS prefs process. If its environment (e.g.
        // If this process resolves paths differently from the gnome-shell session, these can diverge from what
        // the extension actually uses.
        group.add(this._infoRow('State dir', this._paths.data));
        group.add(this._infoRow('Config dir', this._paths.config));

        const status = configStatus(this._paths.config);
        const cfgStatus = status.yamlPresent ? 'config.yaml (takes precedence)'
            : (status.jsonPresent ? 'config.json' : 'defaults (no file)');
        group.add(this._infoRow('Config in use', cfgStatus));

        page.add(group);

        if (status.yamlPresent)
            page.add(this._warningGroup('Editing config.yaml',
                'Your changes are written back to this config.yaml, so they take effect - but any hand-written comments or formatting in the YAML are removed on save.'));

        page.add(this._warningGroup('Image capture is risky inside GNOME Shell',
            'It can destabilize the compositor. Turn it off on the General page if the session gets unstable.'));
    }

    _readMetadataFile() {
        // Read metadata.json directly rather than relying on this.metadata, whose field
        // availability varies across ExtensionPreferences versions.
        try {
            const path = GLib.build_filenamev([this.path, 'metadata.json']);
            const [, contents] = Gio.File.new_for_path(path).load_contents(null);
            return JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            log.warn(`prefs: metadata.json read failed: ${e.message}`);
            return {};
        }
    }

    _infoRow(title, value) {
        const row = new Adw.ActionRow({ title });
        const label = new Gtk.Label({
            label: String(value),
            selectable: true,
            xalign: 1,
            wrap: true,
            valign: Gtk.Align.CENTER,
        });
        label.add_css_class('dim-label');
        row.add_suffix(label);
        return row;
    }

    _warningGroup(title, subtitle) {
        const group = new Adw.PreferencesGroup();
        const row = new Adw.ActionRow({ title, subtitle });
        row.add_suffix(new Gtk.Image({
            icon_name: 'dialog-warning-symbolic', valign: Gtk.Align.CENTER, visible: true,
        }));
        group.add(row);
        return group;
    }
}
