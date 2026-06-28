import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { log } from '../core/log.js';

// Top-panel button. Clicking it (any button / touch) or activating it from the keyboard
// opens the SAME history widget as the global shortcut - see ui/popup.js. The only
// difference between the two is placement: the shortcut centers it, the indicator anchors
// it under this icon. Styling, opacity, search, number quick-paste, clear, and all keyboard
// logic are identical (one widget, two callers). Secondary click is reserved for a future
// context menu.
//
// We pass dontCreateMenu=true so PanelMenu.Button installs a no-op PopupDummyMenu instead of
// a real (empty) dropdown: that makes a stray empty menu box impossible via pointer,
// keyboard, or the panel's hover-switch menuManager.

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init({ onOpen }) {
        super._init(0.0, 'copy-gnome', true);

        this._onOpen = onOpen;

        this._icon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

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
    }

    _open() {
        const targetWindow =
            global.display.get_focus_window?.() ?? global.display.focus_window ?? null;
        try {
            this._onOpen?.(this, targetWindow);
        } catch (e) {
            log.warn(`indicator open failed: ${e.message}`);
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

    vfunc_button_press_event(event) {
        const pointerButton = this._eventButton(event);
        if (pointerButton === Clutter.BUTTON_PRIMARY)
            this._open();
        else if (pointerButton === Clutter.BUTTON_SECONDARY)
            log.debug('[indicator]: secondary click ignored; context menu pending');
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
