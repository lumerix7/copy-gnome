import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import { log } from './log.js';

// Synthesize paste keystrokes from inside the compositor via a Clutter virtual device.
// Allowed on Wayland because we run in gnome-shell. See docs/03-clipboard/README.md.
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

const KEYVALS = {
    ctrl: Clutter.KEY_Control_L,
    shift: Clutter.KEY_Shift_L,
    alt: Clutter.KEY_Alt_L,
    super: Clutter.KEY_Super_L,
    backspace: Clutter.KEY_BackSpace,
    delete: Clutter.KEY_Delete,
    down: Clutter.KEY_Down,
    end: Clutter.KEY_End,
    enter: Clutter.KEY_Return,
    escape: Clutter.KEY_Escape,
    home: Clutter.KEY_Home,
    insert: Clutter.KEY_Insert,
    left: Clutter.KEY_Left,
    'page-down': Clutter.KEY_Page_Down,
    'page-up': Clutter.KEY_Page_Up,
    right: Clutter.KEY_Right,
    space: Clutter.KEY_space,
    tab: Clutter.KEY_Tab,
    up: Clutter.KEY_Up,
};

function normalizeKey(key) {
    return String(key ?? '').trim().toLowerCase();
}

function keyvalFor(key) {
    const normalized = normalizeKey(key);
    if (Object.prototype.hasOwnProperty.call(KEYVALS, normalized))
        return KEYVALS[normalized];
    if (/^[a-z0-9]$/.test(normalized))
        return Clutter[`KEY_${normalized}`];
    if (/^f([1-9]|1[0-2])$/.test(normalized))
        return Clutter[`KEY_${normalized.toUpperCase()}`];
    return undefined;
}

function keysLabel(keys) {
    return Array.isArray(keys) ? keys.map(normalizeKey).join('+') : String(keys);
}

// Press all configured keyvals in order, then release in reverse order.
function injectKeys(keys, prefix) {
    const pressed = [];
    const label = keysLabel(keys);
    try {
        if (!Array.isArray(keys)) {
            log.warn(`${prefix}paste injection skipped keys=${label} reason=invalid-keys`);
            return false;
        }
        if (keys.length === 0) {
            log.debug(`${prefix}paste injection skipped keys=(none)`);
            return true;
        }
        const d = device();
        if (!d || typeof d.notify_keyval !== 'function') {
            log.warn(`${prefix}paste injection skipped keys=${label} reason=virtual-keyboard-unavailable`);
            return false;
        }
        const t = Clutter.get_current_event_time() * 1000;
        for (const key of keys) {
            const keyval = keyvalFor(key);
            if (!Number.isFinite(keyval)) {
                log.warn(`${prefix}paste injection skipped keys=${label} reason=unsupported-key key=${String(key)}`);
                return false;
            }
            d.notify_keyval(t, keyval, Clutter.KeyState.PRESSED);
            pressed.push(keyval);
        }
        for (const keyval of pressed.slice().reverse())
            d.notify_keyval(t, keyval, Clutter.KeyState.RELEASED);
        pressed.length = 0;
        return true;
    } catch (e) {
        log.error(`${prefix}paste injection failed keys=${label}`, e);
        return false;
    } finally {
        try {
            const d = _device;
            const t = Clutter.get_current_event_time() * 1000;
            for (const m of pressed.reverse())
                d?.notify_keyval(t, m, Clutter.KeyState.RELEASED);
        } catch (e) {
            log.error(`${prefix}paste key cleanup failed keys=${label}`, e);
        }
    }
}

// Inject configured paste keys. Wayland has no semantic "paste", so the keybinding is
// per-app. Restore normally prepares the clipboard first; the recent row-1 shortcut may
// skip only that write while leaving paste injection unchanged.
// See docs/03-clipboard/README.md.
export function paste(keys, context = '[paste]') {
    const prefix = context ? `${context}: ` : '[paste]: ';
    log.debug(`${prefix}paste injection keys=${keysLabel(keys) || '(none)'}`);
    return injectKeys(keys, prefix);
}

export function pasteWindowId(window) {
    return window?.get_stable_sequence() ?? null;
}

export function findPasteWindow(id) {
    if (id === null)
        return null;
    const focused = global.display.get_focus_window();
    if (pasteWindowId(focused) === id)
        return focused;
    for (const actor of global.get_window_actors()) {
        const window = actor.meta_window;
        if (pasteWindowId(window) === id)
            return window;
    }
    return null;
}

export function schedulePaste(timers, clipboard, { windowId, recordId, keys, restoreFocus, delayMs }, inject = paste) {
    const context = `[paste] recordId=${recordId} windowId=${windowId}`;
    if (windowId === null) {
        log.warn(`${context}: skipped reason=no-target-window`);
        return;
    }
    const version = clipboard.version;
    const stillCurrent = () => clipboard.active && clipboard.version === version && clipboard.recordId === recordId;
    if (!stillCurrent()) {
        log.warn(`${context}: skipped reason=clipboard-unconfirmed`);
        return;
    }
    const shortcut = keys.slice();
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
        if (!timers.has(id))
            return GLib.SOURCE_REMOVE;
        try {
            log.debug(`${context}: timer started`);
            if (!stillCurrent()) {
                log.warn(`${context}: skipped reason=clipboard-changed expectedVersion=${version} currentVersion=${clipboard.version}`);
                return GLib.SOURCE_REMOVE;
            }
            const target = findPasteWindow(windowId);
            if (!target || target.minimized) {
                log.warn(`${context}: skipped reason=target-unavailable`);
                return GLib.SOURCE_REMOVE;
            }
            if (restoreFocus && pasteWindowId(global.display.get_focus_window()) !== windowId) {
                log.debug(`${context}: activating target`);
                target.activate(global.get_current_time());
            }
            if (pasteWindowId(global.display.get_focus_window()) !== windowId) {
                log.warn(`${context}: skipped reason=target-not-focused`);
                return GLib.SOURCE_REMOVE;
            }
            if (!timers.has(id))
                return GLib.SOURCE_REMOVE;
            if (!stillCurrent()) {
                log.warn(`${context}: skipped reason=clipboard-changed-during-focus`);
                return GLib.SOURCE_REMOVE;
            }
            if (!inject(shortcut, context))
                log.warn(`${context}: injection failed`);
        } catch (error) {
            log.error(`${context}: scheduled paste`, error);
        } finally {
            timers.delete(id);
            log.debug(`${context}: timer finished`);
        }
        return GLib.SOURCE_REMOVE;
    });
    timers.add(id);
    log.debug(`${context}: scheduled delayMs=${delayMs}`);
}

export function resetPaste() {
    _device = null;
}
