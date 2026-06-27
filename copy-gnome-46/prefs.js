import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { loadConfig, saveConfig, configStatus } from './core/config.js';
import { Paths } from './core/paths.js';
import { log } from './core/log.js';

// Preferences window (Adw/Gtk4). Runs in a SEPARATE process from gnome-shell (opened by
// Extension Manager's gear or `gnome-extensions prefs copy-gnome@clipboard`), so a crash here
// never touches the compositor. Shortcuts write GSettings; General/History write the active
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

        window.set_title('copy-gnome');
        window.set_search_enabled(true);

        // Flush any debounced write + tear down any in-progress key capture on close.
        window.connect('close-request', () => {
            this._flushNow();
            return false;
        });

        window.add(this._shortcutsPage());
        window.add(this._generalPage());
        window.add(this._historyPage());
        window.add(this._popupPage());
        window.add(this._aboutPage());
    }

    // Debounced write of the whole merged config to config.json. Coalesces rapid edits (spin
    // scrubbing, fast toggles) into one serialize + synchronous write (fine: prefs is
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

    // ---------- Shortcuts (GSettings) ----------
    _shortcutsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Shortcuts', icon_name: 'input-keyboard-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Keybindings',
            description: 'Press Set, then the keys. Backspace clears; Esc cancels.',
        });
        group.add(this._keybindingRow('toggle-popup',
            'Open clipboard popup',
            'Opens the centered, searchable history list.'));
        page.add(group);
        return page;
    }

    _keybindingRow(key, title, subtitle) {
        const row = new Adw.ActionRow({ title, subtitle });

        const accelLabel = new Gtk.Label({ label: this._readableAccel(key), visible: true });
        accelLabel.add_css_class('dim-label');
        row.add_suffix(accelLabel);

        const setBtn = new Gtk.Button({ label: 'Set', valign: Gtk.Align.CENTER, visible: true });
        setBtn.connect('clicked', () => {
            accelLabel.label = 'Press keys...  (Esc cancels)';
            this._captureKeybinding(key, () => {
                accelLabel.label = this._readableAccel(key);
            });
        });
        row.add_suffix(setBtn);

        const clearBtn = new Gtk.Button({ label: 'Clear', valign: Gtk.Align.CENTER, visible: true });
        clearBtn.connect('clicked', () => {
            this._settings.set_strv(key, []);
            accelLabel.label = this._readableAccel(key);
        });
        row.add_suffix(clearBtn);

        return row;
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

    // ---------- General (config.json) ----------
    _generalPage() {
        const page = new Adw.PreferencesPage({
            title: 'General', icon_name: 'preferences-system-symbolic',
        });
        const group = new Adw.PreferencesGroup({ title: 'Capture' });

        group.add(this._boolRow('captureFiles', 'Capture copied files',
            'Stored as URI/path references only; no file bytes are kept.',
            'general'));
        group.add(this._boolRow('captureImages', 'Capture images / screenshots',
            'Risky on GNOME Shell 46 - can destabilize the compositor. Turn off if the session gets unstable.',
            'general'));

        page.add(group);
        return page;
    }

    _boolRow(field, title, subtitle, section) {
        const row = new Adw.ActionRow({ title, subtitle });
        const sw = new Gtk.Switch({
            active: !!this._config[section][field],
            valign: Gtk.Align.CENTER,
            visible: true,
        });
        sw.connect('notify::active', () => {
            this._config[section][field] = sw.active;
            this._persist();
        });
        row.add_suffix(sw);
        row.activatable_widget = sw;
        return row;
    }

    // ---------- History (config.json) ----------
    _historyPage() {
        const page = new Adw.PreferencesPage({
            title: 'History', icon_name: 'view-list-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Limits',
            description: 'History limits take full effect after you disable/enable the extension.',
        });

        group.add(this._spinRow('maxItems', 'Max history items', 1, 100, 1,
            'history', v => v, v => Math.round(v)));
        group.add(this._spinRow('maxItemBytes', 'Max item size (KiB)', 1, 65536, 1,
            'history', v => Math.round(v / 1024), v => Math.round(v) * 1024));
        group.add(this._spinRow('maxAgeDays', 'Expire after days (0 = never)', 0, 3650, 1,
            'history', v => v, v => Math.round(v)));
        group.add(this._boolRow('dedup', 'Deduplicate by content hash',
            'Merge identical entries (same sha256). Recommended.', 'history'));

        page.add(group);
        return page;
    }

    _spinRow(field, title, min, max, step, section, toSpin, fromSpin) {
        const row = new Adw.ActionRow({ title });
        const spin = Gtk.SpinButton.new_with_range(min, max, step);
        spin.value = toSpin(this._config[section][field]);
        spin.valign = Gtk.Align.CENTER;
        spin.visible = true;
        spin.connect('value-changed', () => {
            this._config[section][field] = fromSpin(spin.value);
            this._persist();
        });
        row.add_suffix(spin);
        return row;
    }

    // ---------- Popup (config.json) ----------
    _popupPage() {
        const page = new Adw.PreferencesPage({
            title: 'Popup', icon_name: 'preferences-desktop-symbolic',
        });

        const win = new Adw.PreferencesGroup({ title: 'Window' });
        win.add(this._spinRow('popupWidth', 'Width (px)', 240, 900, 10,
            'ui', v => v, v => Math.round(v)));
        win.add(this._spinRow('popupMaxHeight', 'Max height (px)', 120, 1200, 10,
            'ui', v => v, v => Math.round(v)));
        win.add(this._spinRow('popupOpacity', 'Opacity (%)', 10, 100, 1,
            'ui', v => Math.round(v * 100), v => v / 100));
        page.add(win);

        const beh = new Adw.PreferencesGroup({ title: 'Behavior' });
        const autoPasteRow = this._boolRow('autoPaste', 'Auto-paste after restore',
            'After setting the clipboard, also inject the paste key (Ctrl+V, or the app-specific combo). Off = set the clipboard only.', 'ui');
        const delayRow = this._spinRow('autoPasteDelayMs', 'Auto-paste delay (ms)', 0, 5000, 1,
            'ui', v => v, v => Math.round(v));
        beh.add(autoPasteRow);
        beh.add(delayRow);
        beh.add(this._spinRow('numberPickTimeoutMs', 'Number-pick timeout (ms)', 100, 5000, 1,
            'ui', v => v, v => Math.round(v)));
        page.add(beh);

        // Disable the delay control when auto-paste is off (the value has no effect then).
        const apSwitch = autoPasteRow.activatable_widget;
        if (apSwitch) {
            const syncDelay = () => delayRow.set_sensitive(apSwitch.active);
            apSwitch.connect('notify::active', syncDelay);
            syncDelay();
        }

        return page;
    }

    // ---------- About (read-only) ----------
    _aboutPage() {
        const page = new Adw.PreferencesPage({
            title: 'About', icon_name: 'help-about-symbolic',
        });
        const group = new Adw.PreferencesGroup({ title: 'copy-gnome' });

        const md = this._readMetadataFile();
        const shellVer = Array.isArray(md['shell-version'])
            ? md['shell-version'].join('.')
            : (md['shell-version'] ?? '?');
        group.add(this._infoRow('Version', md['version-name'] ?? '?'));
        group.add(this._infoRow('UUID', md.uuid ?? '?'));
        group.add(this._infoRow('GNOME Shell', shellVer));
        // NOTE: paths are resolved by THIS prefs process. If its environment (e.g.
        // COPY_GNOME_HOME) differs from the gnome-shell session, these can diverge from what
        // the extension actually uses.
        group.add(this._infoRow('Data home', this._paths.base));
        group.add(this._infoRow('Config dir', this._paths.config));

        const status = configStatus(this._paths.config);
        const cfgStatus = status.yamlPresent ? 'config.yaml (takes precedence)'
            : (status.jsonPresent ? 'config.json' : 'defaults (no file)');
        group.add(this._infoRow('Config in use', cfgStatus));
        group.add(this._infoRow('Logs', 'journalctl --user | grep -i copy-gnome'));

        page.add(group);

        if (status.yamlPresent)
            page.add(this._warningGroup('Editing config.yaml',
                'Your changes are written back to this config.yaml, so they take effect - but any hand-written comments or formatting in the YAML are removed on save.'));

        page.add(this._warningGroup('Image capture is risky on Shell 46',
            'It can destabilize the compositor. Turn it off on the General page if the session gets unstable. See WARNING.md.'));

        return page;
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
        return new Adw.ActionRow({ title, subtitle: String(value) });
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
