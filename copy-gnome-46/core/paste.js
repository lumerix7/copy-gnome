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
function injectCombo(mods, key, combo, prefix) {
    const pressed = [];
    try {
        const d = device();
        if (!d || typeof d.notify_keyval !== 'function') {
            log.warn(`${prefix}paste injection skipped combo=${combo} reason=virtual-keyboard-unavailable`);
            return false;
        }
        const t = Clutter.get_current_event_time() * 1000;
        for (const m of mods) {
            d.notify_keyval(t, m, Clutter.KeyState.PRESSED);
            pressed.push(m);
        }
        d.notify_keyval(t, key, Clutter.KeyState.PRESSED);
        d.notify_keyval(t, key, Clutter.KeyState.RELEASED);
        return true;
    } catch (e) {
        log.warn(`${prefix}paste injection failed combo=${combo} reason=${e.message}`);
        return false;
    } finally {
        try {
            const d = _device;
            const t = Clutter.get_current_event_time() * 1000;
            for (const m of pressed.reverse())
                d?.notify_keyval(t, m, Clutter.KeyState.RELEASED);
        } catch (e) {
            log.warn(`${prefix}paste modifier cleanup failed combo=${combo} reason=${e.message}`);
        }
    }
}

// Inject a named paste combo. Wayland has no semantic "paste", so the combo is
// per-app. Restore normally prepares the clipboard first; the recent row-1 shortcut may
// skip only that write while leaving paste injection unchanged.
// See docs/03-clipboard.md.
export function paste(combo, context = '[paste]') {
    const prefix = context ? `${context}: ` : '[paste]: ';
    switch (combo) {
        case 'none':
            log.debug(`${prefix}paste injection skipped combo=none`);
            return true;
        case 'shift-insert':
            log.debug(`${prefix}paste injection combo=shift-insert`);
            return injectCombo([Clutter.KEY_Shift_L], Clutter.KEY_Insert, 'shift-insert', prefix);
        case 'ctrl-shift-v':
            log.debug(`${prefix}paste injection combo=ctrl-shift-v`);
            return injectCombo([Clutter.KEY_Control_L, Clutter.KEY_Shift_L], Clutter.KEY_v, 'ctrl-shift-v', prefix);
        case 'ctrl-v':
            log.debug(`${prefix}paste injection combo=ctrl-v`);
            return injectCombo([Clutter.KEY_Control_L], Clutter.KEY_v, 'ctrl-v', prefix);
        default:
            log.warn(`${prefix}paste combo ${String(combo)} unsupported; using ctrl-v`);
            return injectCombo([Clutter.KEY_Control_L], Clutter.KEY_v, 'ctrl-v', prefix);
    }
}

export function resetPaste() {
    _device = null;
}
