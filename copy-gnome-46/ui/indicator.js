import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { log } from '../core/log.js';

// Top-panel button. Clicking it (any button / touch) or activating it from the keyboard
// opens the SAME history widget as the global shortcut - see ui/popup.js. The only
// difference between the two is placement: the shortcut centers it, the indicator anchors
// it under this icon. Styling, opacity, search, number quick-paste, clear, and all keyboard
// logic are identical (one widget, two callers). There are no right-click actions.
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

    // Open the shared popup on any button press / touch, anchored under this icon. We stop
    // the event so the parent's default (toggling the dummy menu) never runs.
    vfunc_event(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            this._open();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // The popup reads live history when it opens, so there is nothing to rebuild here. Kept
    // because the extension nudges the indicator on history/pause changes.
    refresh() {}
});
