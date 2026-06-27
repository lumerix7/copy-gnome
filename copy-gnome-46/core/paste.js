import Clutter from 'gi://Clutter';

import { log } from './log.js';

// Synthesize paste keystrokes from inside the compositor via a Clutter virtual device.
// Allowed on Wayland because we run in gnome-shell. See docs/03-clipboard.md.
//
// Time arg to notify_keyval is in MICROSECONDS - the shell's own OSK uses
// `Clutter.get_current_event_time() * 1000` (keyboard.js).

let _device = null;

function device() {
    if (!_device) {
        const seat = Clutter.get_default_backend().get_default_seat();
        _device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }
    return _device;
}

// Press the given modifier keyvals + `key`, then release in reverse order.
function injectCombo(mods, key) {
    const pressed = [];
    try {
        const d = device();
        const t = Clutter.get_current_event_time() * 1000;
        for (const m of mods) {
            d.notify_keyval(t, m, Clutter.KeyState.PRESSED);
            pressed.push(m);
        }
        d.notify_keyval(t, key, Clutter.KeyState.PRESSED);
        d.notify_keyval(t, key, Clutter.KeyState.RELEASED);
    } catch (e) {
        log.warn(`paste injection failed: ${e.message}`);
    } finally {
        try {
            const d = _device;
            const t = Clutter.get_current_event_time() * 1000;
            for (const m of pressed.reverse())
                d?.notify_keyval(t, m, Clutter.KeyState.RELEASED);
        } catch (e) {
            log.warn(`paste modifier cleanup failed: ${e.message}`);
        }
    }
}

// Inject a named paste combo. Wayland has no semantic "paste", so the combo is
// per-app; the clipboard is always set by the caller regardless, so a wrong/`none`
// combo just means the user pastes manually. See docs/03-clipboard.md.
export function paste(combo) {
    switch (combo) {
        case 'none':
            return;
        case 'shift-insert':
            injectCombo([Clutter.KEY_Shift_L], Clutter.KEY_Insert);
            return;
        case 'ctrl-shift-v':
            injectCombo([Clutter.KEY_Control_L, Clutter.KEY_Shift_L], Clutter.KEY_v);
            return;
        case 'ctrl-v':
        default:
            injectCombo([Clutter.KEY_Control_L], Clutter.KEY_v);
            return;
    }
}

export function resetPaste() {
    _device = null;
}
