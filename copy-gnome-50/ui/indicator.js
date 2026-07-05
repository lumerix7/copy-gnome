import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { log } from '../core/log.js';

// Top-panel button. Clicking it (any button / touch) or activating it from the keyboard
// opens the SAME history widget as the global shortcut - see ui/popup.js. The only
// difference between the two is placement: the shortcut centers it, the indicator anchors
// it under this icon. Styling, opacity, search, number quick-paste, clear, and all keyboard
// logic are identical (one widget, two callers). Secondary click opens a small context menu.

class ConfirmMenuItem extends PopupMenu.PopupMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(label, onActivate) {
        super(label);
        this._onActivate = onActivate;
    }

    activate(event) {
        this._onActivate?.(event);
    }
}

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init({ onOpen, onShow, onClear, onPreferences }) {
        // WARNING: keep dontCreateMenu=true. PanelMenu.Button's real menu installs its own
        // click gesture and treats primary click as menu toggle on GNOME 50. This indicator
        // needs primary click for history popup and secondary click for the context menu.
        super._init(0.0, 'copy-gnome', true);

        this._onOpen = onOpen;
        this._onShow = onShow ?? onOpen;
        this._onClear = onClear ?? (() => {});
        this._onPreferences = onPreferences ?? (() => {});
        this._clearArmed = false;
        this._clearConfirmTimer = 0;
        this._clearItem = null;
        // WARNING: this must stay separate from this.menu. `this.menu` is the dummy menu from
        // dontCreateMenu=true; using a real PanelMenu.Button menu regresses primary click.
        this._contextMenuManager = new PopupMenu.PopupMenuManager(this);
        this._contextMenu = new PopupMenu.PopupMenu(this, 0.0, St.Side.TOP);
        this._contextMenu.actor.hide();
        this._contextMenuManager.addMenu(this._contextMenu);
        Main.uiGroup.add_child(this._contextMenu.actor);

        this._icon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._contextMenu.addAction('Show', () => this._show());
        this._clearItem = new ConfirmMenuItem('Clear history', event => this._onClearMenu(event));
        this._contextMenu.addMenuItem(this._clearItem);
        this._contextMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._contextMenu.addAction('Preferences', () => this._openPreferences());

        // Keyboard activation (Top Bar navigation → Enter/Space) opens the popup too.
        this.connect('key-press-event', (_actor, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter ||
                sym === Clutter.KEY_space) {
                this._open();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('destroy', () => {
            this._clearArmed = false;
            this._cancelClearTimer();
            this._clearItem = null;
            this._contextMenu?.destroy?.();
            this._contextMenu = null;
            this._contextMenuManager = null;
        });
    }

    _open() {
        const targetWindow =
            global.display.get_focus_window?.() ?? global.display.focus_window ?? null;
        try {
            this._contextMenu?.close?.();
            this._onOpen?.(this, targetWindow);
        } catch (e) {
            log.warn(`indicator open failed: ${e.message}`);
        }
    }

    _show() {
        const targetWindow =
            global.display.get_focus_window?.() ?? global.display.focus_window ?? null;
        try {
            this._contextMenu?.close?.();
            this._onShow?.(this, targetWindow);
        } catch (e) {
            log.warn(`indicator show failed: ${e.message}`);
        }
    }

    _openPreferences() {
        try {
            this._contextMenu?.close?.();
            this._onPreferences();
        } catch (e) {
            log.warn(`indicator preferences failed: ${e.message}`);
        }
    }

    _eventButton(event) {
        try {
            return event.get_button();
        } catch (e) {
            log.debug(`indicator button unavailable: ${e.message}`);
            return 0;
        }
    }

    _onClearMenu(_event) {
        if (!this._clearArmed) {
            this._clearArmed = true;
            if (this._clearItem)
                this._clearItem.label.text = 'Click again to clear all';
            if (this._clearConfirmTimer) {
                try {
                    GLib.Source.remove(this._clearConfirmTimer);
                } catch (e) {
                    log.debug(`indicator clear confirm cleanup failed: ${e.message}`);
                }
            }
            this._clearConfirmTimer = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 3000, () => {
                    this._clearConfirmTimer = 0;
                    this._disarmClear();
                    log.debug('[indicator]: clear history confirmation expired');
                    return GLib.SOURCE_REMOVE;
                });
            log.debug('[indicator]: clear history armed from context menu');
            return;
        }

        this._disarmClear();
        try {
            this._onClear();
            log.debug('[indicator]: clear history confirmed from context menu');
        } catch (e) {
            log.warn(`indicator clear failed: ${e.message}`);
        }
        this._contextMenu?.close?.();
    }

    _toggleMenu() {
        try {
            this._disarmClear();
            this._contextMenu?.toggle?.();
            log.debug('[indicator]: context menu toggled from secondary click');
        } catch (e) {
            log.warn(`indicator context menu failed: ${e.message}`);
        }
    }

    _cancelClearTimer() {
        if (!this._clearConfirmTimer)
            return;
        try {
            GLib.Source.remove(this._clearConfirmTimer);
        } catch (e) {
            log.debug(`indicator clear confirm cleanup failed: ${e.message}`);
        }
        this._clearConfirmTimer = 0;
    }

    _disarmClear() {
        this._clearArmed = false;
        this._cancelClearTimer();
        if (this._clearItem)
            this._clearItem.label.text = 'Clear history';
    }

    vfunc_button_press_event(event) {
        const pointerButton = this._eventButton(event);
        if (pointerButton === Clutter.BUTTON_PRIMARY)
            this._open();
        else if (pointerButton === Clutter.BUTTON_SECONDARY)
            this._toggleMenu();
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(_event) {
        return Clutter.EVENT_STOP;
    }

    // Open the shared popup on touch, anchored under this icon. Mouse button handling lives in
    // vfunc_button_press_event/release_event so there is a single pointer path.
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            this._open();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // The popup reads live history when it opens, so there is nothing to rebuild here. Kept
    // because the extension nudges the indicator on history changes.
    refresh() {}
});
