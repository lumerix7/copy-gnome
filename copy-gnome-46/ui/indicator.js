import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { log } from '../core/log.js';
import { Completions } from '../core/completions.js';

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
        this._work = new Completions();
        this._cancelClear = null;
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
        this._clearItem = new ConfirmMenuItem('Clear history',
            this._work.onSignal('indicator clear confirmation', () => this._onClearMenu()));
        this._contextMenu.addMenuItem(this._clearItem);
        this._contextMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._contextMenu.addAction('Preferences', () => this._openPreferences());

        // Keyboard activation (Top Bar navigation → Enter/Space) opens the popup too.
        this.connect('key-press-event', (_actor, event) => {
            if (!this._work)
                return Clutter.EVENT_STOP;
            try {
                const sym = event.get_key_symbol();
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter || sym === Clutter.KEY_space) {
                    this._open();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            } catch (error) {
                log.error('indicator key-press-event', error);
                return Clutter.EVENT_STOP;
            }
        });
        this.connect('destroy', () => {
            this.retire();
            this._clearItem = null;
            const menu = this._contextMenu;
            this._contextMenu = null;
            this._contextMenuManager = null;
            try {
                menu?.destroy();
            } catch (error) {
                log.error('indicator menu cleanup', error);
            }
        });
    }

    retire() {
        const work = this._work;
        this._work = null;
        this._clearArmed = false;
        this._cancelClear = null;
        work?.close();
    }

    _open() {
        if (!this._work) return;
        try {
            const targetWindow = global.display.get_focus_window?.() ?? global.display.focus_window ?? null;
            this._contextMenu?.close?.();
            this._onOpen?.(this, targetWindow);
        } catch (e) {
            log.error('indicator open failed', e);
        }
    }

    _show() {
        if (!this._work) return;
        try {
            const targetWindow = global.display.get_focus_window?.() ?? global.display.focus_window ?? null;
            this._contextMenu?.close?.();
            this._onShow?.(this, targetWindow);
        } catch (e) {
            log.error('indicator show failed', e);
        }
    }

    _openPreferences() {
        if (!this._work) return;
        try {
            this._contextMenu?.close?.();
            this._onPreferences();
        } catch (e) {
            log.error('indicator preferences failed', e);
        }
    }

    _eventButton(event) {
        try {
            return event.get_button();
        } catch (e) {
            log.debug('indicator button unavailable', e);
            return 0;
        }
    }

    _onClearMenu() {
        if (!this._work) return;
        if (!this._clearArmed) {
            this._cancelClear = this._work.after('indicator clear confirmation timeout', 3000, () => {
                this._cancelClear = null;
                this._disarmClear();
                log.debug('[indicator]: clear history confirmation expired');
            });
            if (!this._cancelClear)
                return;
            try {
                if (this._clearItem)
                    this._clearItem.label.text = 'Click again to clear all';
            } catch (error) {
                const cancel = this._cancelClear;
                this._cancelClear = null;
                cancel();
                log.error('indicator show clear confirmation', error);
                return;
            }
            this._clearArmed = true;
            log.debug('[indicator]: clear history armed from context menu');
            return;
        }

        this._disarmClear();
        try {
            this._onClear();
            log.debug('[indicator]: clear history confirmed from context menu');
        } catch (e) {
            log.error('indicator clear failed', e);
        }
        this._contextMenu?.close?.();
    }

    _toggleMenu() {
        if (!this._work) return;
        try {
            this._disarmClear();
            this._contextMenu?.toggle?.();
            log.debug('[indicator]: context menu toggled from secondary click');
        } catch (e) {
            log.error('indicator context menu failed', e);
        }
    }

    _disarmClear() {
        this._clearArmed = false;
        const cancel = this._cancelClear;
        this._cancelClear = null;
        cancel?.();
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
        if (!this._work) return Clutter.EVENT_PROPAGATE;
        try {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                this._open();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        } catch (error) {
            log.error('indicator event', error);
            return Clutter.EVENT_STOP;
        }
    }

    // The popup reads live history when it opens, so there is nothing to rebuild here. Kept
    // because the extension nudges the indicator on history changes.
    refresh() {}
});
