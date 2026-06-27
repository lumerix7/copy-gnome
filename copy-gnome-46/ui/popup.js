import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { log } from '../core/log.js';

// Modal, searchable history list. See docs/07-ui.md. The grabbed actor is a full-monitor
// backdrop (so clicks outside the panel dismiss it); the panel is centered on the active
// monitor. Near-caret anchoring was removed because GNOME/Wayland caret reporting is not
// reliable across apps or repeated modal grabs.

const DOUBLE_CLICK_US = 400000;   // 400 ms
const DEFAULT_UI = {
    popupWidth: 640,
    popupMaxHeight: 800,
    popupOffsetX: 0,
    popupOffsetY: 0,
    popupEdgeMargin: 8,
    popupOpacity: 0.82,
    numberPickTimeoutMs: 800,
};

// Keyboard hint shown per row, matching the number quick-paste keys (1..N, 0 for the 10th).
// Hint shows the real row number (1..N). Pressing standalone `0` still selects row 10 — that
// key binding lives in _onNumberPickDigit and is unchanged; only this label was "0" → "10".
function rowHint(i) {
    return `${i + 1}`;
}

function previewLabel(rec) {
    if (rec.preview) return rec.preview;
    if (rec.text) return rec.text.replace(/\s+/g, ' ').slice(0, 80);
    return `[${rec.kind}]`;
}

function timeLabel(rec) {
    const micros = Number(rec.usedAt || rec.createdAt || 0);
    if (!micros)
        return '';
    try {
        const dt = GLib.DateTime.new_from_unix_local(Math.floor(micros / 1000000));
        return dt.format('%m-%d %H:%M');
    } catch (e) {
        return '';
    }
}

function matches(rec, query) {
    if (!query) return true;
    const hay = (rec.text || rec.uri || rec.preview || rec.kind || '').toLowerCase();
    return hay.includes(query.toLowerCase());
}

function clamp(n, min, max) {
    if (max < min)
        return min;
    return Math.max(min, Math.min(n, max));
}

function num(v, fallback, min = -Infinity, max = Infinity) {
    if (typeof v !== 'number' || Number.isNaN(v))
        return fallback;
    return clamp(v, min, max);
}

function uiDefaults(ui) {
    return { ...DEFAULT_UI, ...(ui ?? {}) };
}

function actorContains(container, actor) {
    for (let a = actor; a; a = a.get_parent?.()) {
        if (a === container)
            return true;
    }
    return false;
}

function monitorByIndex(index) {
    if (typeof index !== 'number' || index < 0)
        return null;
    return Main.layoutManager.monitors?.[index] ??
        global.display.get_monitor_geometry(index);
}

function focusedMonitor() {
    const win = global.display.focus_window ?? global.display.get_focus_window?.();
    if (!win || win.minimized)
        return null;
    return monitorByIndex(win.get_monitor?.());
}

// Monitor whose geometry contains an actor's top-left (places the panel-anchored variant
// on the same monitor as the indicator icon).
function monitorForActor(actor) {
    try {
        const [x, y] = actor.get_transformed_position();
        for (const m of (Main.layoutManager.monitors ?? [])) {
            if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
                return m;
        }
    } catch (e) {
        log.debug(`monitorForActor failed: ${e.message}`);
    }
    return null;
}

function ensureActorVisibleInScrollView(scrollView, actor) {
    const adjustment = scrollView?.vadjustment ??
        scrollView?.get_vscroll_bar?.()?.get_adjustment?.();
    if (!adjustment || !actor)
        return;

    const { value: oldValue, pageSize, upper } = adjustment;
    if (pageSize <= 0 || upper <= pageSize)
        return;

    const box = actor.get_allocation_box();
    let y1 = box.y1;
    let y2 = box.y2;

    let parent = actor.get_parent();
    while (parent && parent !== scrollView) {
        const parentBox = parent.get_allocation_box();
        y1 += parentBox.y1;
        y2 += parentBox.y1;
        parent = parent.get_parent();
    }
    if (parent !== scrollView)
        return;

    let value = oldValue;
    if (y1 < oldValue)
        value = Math.max(0, y1);
    else if (y2 > oldValue + pageSize)
        value = Math.min(upper - pageSize, y2 - pageSize);

    if (value !== oldValue)
        adjustment.set_value(value);
}

export class Popup {
    constructor({ getItems, onActivate, onClear, getUi }) {
        this._getItems = getItems;
        this._onActivate = onActivate;
        this._onClear = onClear ?? (() => {});
        this._getUi = getUi ?? (() => null);

        this._backdrop = null;
        this._panel = null;
        this._entry = null;
        this._hint = null;
        this._scrollView = null;
        this._listBox = null;
        this._grab = null;
        this._rows = [];        // [{rec, button}]
        this._selected = -1;
        this._visible = false;
        this._lastClickIdx = -1;
        this._lastClickTime = 0;
        this._numberPickBuffer = '';
        this._numberPickTimer = 0;
        this._targetWindow = null;
        this._anchorActor = null;
        this._clearBtn = null;
        this._clearArmed = false;
        this._clearConfirmTimer = 0;
    }

    get visible() { return this._visible; }

    // opts: { placement: 'center'|'panel', anchorActor }. The ONLY difference between the
    // two callers is placement; both share the same translucent styling and all logic.
    toggle(targetWindow = null, opts = {}) {
        if (this._visible) this.hide();
        else this.show(targetWindow, opts);
    }

    show(targetWindow = null, opts = {}) {
        if (this._visible) return;

        let modalPushed = false;
        try {
        this._targetWindow = targetWindow ??
            global.display.get_focus_window?.() ?? global.display.focus_window ?? null;
        const placement = opts.placement === 'panel' ? 'panel' : 'center';
        const anchorActor = opts.anchorActor ?? null;
        this._anchorActor = anchorActor;
        const ui = uiDefaults(this._getUi());
        let width = num(ui.popupWidth, DEFAULT_UI.popupWidth, 240, 900);
        let maxHeight = num(ui.popupMaxHeight, DEFAULT_UI.popupMaxHeight, 120, 1200);
        const edgeMargin = num(ui.popupEdgeMargin, DEFAULT_UI.popupEdgeMargin, 0, 96);
        const opacity = num(ui.popupOpacity, DEFAULT_UI.popupOpacity, 0.1, 1);
        const numberPickTimeoutMs = num(
            ui.numberPickTimeoutMs, DEFAULT_UI.numberPickTimeoutMs, 100, 5000);
        const offsetX = num(ui.popupOffsetX, DEFAULT_UI.popupOffsetX, -1000, 1000);
        const offsetY = num(ui.popupOffsetY, DEFAULT_UI.popupOffsetY, -1000, 1000);
        this._numberPickTimeoutMs = numberPickTimeoutMs;

        const monitor = (placement === 'panel' ? monitorForActor(anchorActor) : null) ??
            focusedMonitor() ?? Main.layoutManager.currentMonitor;
        if (!monitor) return;
        width = Math.min(width, Math.max(240, monitor.width - edgeMargin * 2));
        // maxHeight caps only the scroll list. Reserve room for the rest of the panel (search
        // entry + number hint + footer + padding/spacing) so the *whole* panel fits the
        // monitor; otherwise on short screens natH exceeds the monitor and the footer (Clear)
        // is clipped. ~96px is a conservative upper bound for that chrome at default styling.
        const panelChromePx = 96;
        maxHeight = Math.min(maxHeight,
            Math.max(120, monitor.height - edgeMargin * 2 - panelChromePx));

        this._backdrop = new St.Widget({
            reactive: true,
            can_focus: true,
            x: monitor.x, y: monitor.y,
            width: monitor.width, height: monitor.height,
            layout_manager: new Clutter.FixedLayout(),
            style_class: 'cg-backdrop',
        });

        this._panel = new St.BoxLayout({
            vertical: true,
            style_class: 'cg-popup',
            width,
        });
        this._panel.opacity = Math.round(opacity * 255);
        this._backdrop.add_child(this._panel);

        this._entry = new St.Entry({
            style_class: 'cg-search',
            hint_text: 'Search clipboard... ',
            can_focus: true,
            x_expand: true,
        });
        this._panel.add_child(this._entry);

        this._hint = new St.Label({
            text: '',
            style_class: 'cg-number-hint',
            visible: false,
            x_expand: true,
        });
        this._panel.add_child(this._hint);

        this._scrollView = new St.ScrollView({
            style_class: 'cg-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            y_expand: true,
        });
        this._scrollView.set_style(`max-height: ${maxHeight}px;`);
        this._listBox = new St.BoxLayout({ vertical: true, style_class: 'cg-list' });
        this._scrollView.set_child(this._listBox);
        this._panel.add_child(this._scrollView);

        // Clear history lives in the shared widget (not a right-click menu), so both the
        // centered popup and the panel-anchored window expose it identically.
        const footer = new St.BoxLayout({ style_class: 'cg-footer', x_expand: true });
        this._clearBtn = new St.Button({
            style_class: 'cg-clear',
            label: 'Clear history',
            can_focus: false,
            x_expand: false,
        });
        this._clearArmed = false;
        this._clearBtn.connect('clicked', () => this._onClearClicked());
        footer.add_child(this._clearBtn);
        this._panel.add_child(footer);

        Main.layoutManager.uiGroup.add_child(this._backdrop);

        this._entry.clutter_text.connect('text-changed', () => this._rebuild());
        this._entry.clutter_text.connect('key-press-event',
            (_ct, event) => this._onKey(event));
        this._backdrop.connect('key-press-event',
            (_a, event) => this._onKey(event));
        this._backdrop.connect('button-press-event',
            (_a, event) => this._onBackdropPress(event));

        this._rebuild();

        const [, natH] = this._panel.get_preferred_height(width);
        let gx, gy;
        if (placement === 'panel' && anchorActor) {
            // Drop down from under the icon, right edge aligned to the icon's right edge.
            const [ax, ay] = anchorActor.get_transformed_position();
            const [aw, ah] = anchorActor.get_transformed_size();
            gx = ax + aw - width;
            gy = ay + ah + 4;
        } else {
            gx = monitor.x + (monitor.width - width) / 2 + offsetX;
            gy = monitor.y + (monitor.height - natH) / 2 + offsetY;
        }

        let lx = gx - monitor.x;
        let ly = gy - monitor.y;
        lx = clamp(lx, edgeMargin, monitor.width - width - edgeMargin);
        ly = clamp(ly, edgeMargin, monitor.height - natH - edgeMargin);
        this._panel.set_position(Math.round(lx), Math.round(ly));

        this._grab = Main.pushModal(this._backdrop, { actionMode: Shell.ActionMode.POPUP });
        if (!this._grab) {
            log.warn('failed to grab input for popup');
            this.hide();
            return;
        }
        modalPushed = true;
        this._visible = true;
        global.stage.set_key_focus(this._backdrop);
        } catch (e) {
            log.warn(`popup show failed: ${e.message}`);
            this._cleanupAfterFailedShow(modalPushed);
        }
    }

    hide() {
        this._clearNumberPick();
        this._disarmClear();
        if (this._grab) {
            try {
                Main.popModal(this._grab);
            } catch (e) {
                log.warn(`popup modal release failed: ${e.message}`);
            }
            this._grab = null;
        }
        if (this._backdrop) {
            try {
                this._backdrop.destroy();
            } catch (e) {
                log.warn(`popup destroy failed: ${e.message}`);
            }
            this._backdrop = null;
        }
        this._panel = null;
        this._entry = null;
        this._hint = null;
        this._scrollView = null;
        this._listBox = null;
        this._rows = [];
        this._selected = -1;
        this._targetWindow = null;
        this._anchorActor = null;
        this._clearBtn = null;
        this._visible = false;
    }

    _cleanupAfterFailedShow(modalPushed) {
        if (modalPushed && this._grab) {
            try {
                Main.popModal(this._grab);
            } catch (e) {
                log.warn(`popup modal cleanup failed: ${e.message}`);
            }
        }
        this._grab = null;
        this._clearNumberPick();
        this._disarmClear();
        if (this._backdrop) {
            try {
                this._backdrop.destroy();
            } catch (e) {
                log.warn(`popup failed-show destroy failed: ${e.message}`);
            }
        }
        this._backdrop = null;
        this._panel = null;
        this._entry = null;
        this._hint = null;
        this._scrollView = null;
        this._listBox = null;
        this._rows = [];
        this._selected = -1;
        this._targetWindow = null;
        this._anchorActor = null;
        this._clearBtn = null;
        this._visible = false;
    }

    _onClearClicked() {
        // Two-step confirm. We already hold a modal grab, so opening a separate confirm
        // dialog would mean nesting grabs; instead the first click arms + relabels the
        // button and the second click (within 3s) actually clears.
        if (!this._clearArmed) {
            this._clearArmed = true;
            if (this._clearBtn) {
                this._clearBtn.add_style_class_name('cg-clear-armed');
                this._clearBtn.label = 'Click again to clear all';
            }
            if (this._clearConfirmTimer) {
                try { GLib.Source.remove(this._clearConfirmTimer); } catch (e) {}
            }
            this._clearConfirmTimer = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 3000, () => {
                    this._clearConfirmTimer = 0;
                    this._disarmClear();
                    return GLib.SOURCE_REMOVE;
                });
            return;
        }

        this._disarmClear();
        try {
            this._onClear();
        } catch (e) {
            log.warn(`popup clear failed: ${e.message}`);
        }
        // Reset the filter so the now-empty history shows "(empty)", not "(no matches)".
        this._entry?.set_text('');
        this._rebuild();
    }

    _disarmClear() {
        this._clearArmed = false;
        if (this._clearConfirmTimer) {
            try {
                GLib.Source.remove(this._clearConfirmTimer);
            } catch (e) {
                log.debug(`clear confirm cleanup failed: ${e.message}`);
            }
            this._clearConfirmTimer = 0;
        }
        if (this._clearBtn) {
            try {
                this._clearBtn.remove_style_class_name('cg-clear-armed');
                this._clearBtn.label = 'Clear history';
            } catch (e) {
                // button already destroyed during teardown; nothing to reset
            }
        }
    }

    _rebuild() {
        if (!this._entry || !this._listBox)
            return;
        const query = this._entry.get_text();
        this._listBox.destroy_all_children();
        this._rows = [];

        let items = [];
        try {
            // Render every matching entry. History is already bounded by `history.maxItems`,
            // and the list scrolls via `popupMaxHeight`, so there is no row-count limit here.
            items = this._getItems().filter(r => matches(r, query));
        } catch (e) {
            log.warn(`popup rebuild failed: ${e.message}`);
        }
        if (items.length === 0) {
            // (no matches) only when a search filtered everything out; otherwise the
            // history is genuinely empty.
            const text = query ? '(no matches)' : '(empty)';
            const empty = new St.Label({ text, style_class: 'cg-empty' });
            this._listBox.add_child(empty);
            this._selected = -1;
            return;
        }

        items.forEach((rec, i) => {
            const button = new St.Button({
                style_class: 'cg-row',
                x_expand: true,
                can_focus: false,
            });
            const box = new St.BoxLayout({ style_class: 'cg-row-box', x_expand: true });
            const num = new St.Label({ text: rowHint(i), style_class: 'cg-num' });
            box.add_child(num);
            const label = new St.Label({ text: previewLabel(rec), x_expand: true });
            label.clutter_text.set_single_line_mode(true);
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            box.add_child(label);
            const kind = new St.Label({ text: rec.kind, style_class: 'cg-kind' });
            box.add_child(kind);
            box.add_child(new St.Label({ text: timeLabel(rec), style_class: 'cg-time' }));
            button.set_child(box);

            // Single click selects; second click on the same row within the threshold
            // pastes (shell idiom: `clicked` + manual timing, not get_click_count).
            button.connect('clicked', () => {
                const now = GLib.get_monotonic_time();
                this._select(i);
                if (this._lastClickIdx === i && now - this._lastClickTime < DOUBLE_CLICK_US) {
                    this._lastClickIdx = -1;
                    this._activate(rec);
                } else {
                    this._lastClickIdx = i;
                    this._lastClickTime = now;
                }
            });
            button.connect('notify::hover', () => {
                if (button.hover) this._select(i);
            });
            this._listBox.add_child(button);
            this._rows.push({ rec, button });
        });

        this._select(0);
    }

    _select(i) {
        if (i < 0 || i >= this._rows.length) return;
        if (this._selected >= 0 && this._selected < this._rows.length)
            this._rows[this._selected].button.remove_style_class_name('cg-selected');
        this._selected = i;
        this._rows[i].button.add_style_class_name('cg-selected');
        this._ensureSelectedVisible();
    }

    _ensureSelectedVisible() {
        if (!this._scrollView || this._selected < 0 || this._selected >= this._rows.length)
            return;

        try {
            ensureActorVisibleInScrollView(this._scrollView, this._rows[this._selected].button);
        } catch (e) {
            log.debug(`scroll selected row failed: ${e.message}`);
        }
    }

    _showNumberHint(text, warning = false) {
        if (!this._hint)
            return;
        if (warning)
            this._hint.add_style_class_name('cg-number-hint-warning');
        else
            this._hint.remove_style_class_name('cg-number-hint-warning');
        this._hint.set_text(text);
        this._hint.visible = text !== '';
    }

    _activateRow(i) {
        if (i < 0 || i >= this._rows.length)
            return;
        this._select(i);
        this._activate(this._rows[i].rec);
    }

    _activate(rec) {
        const targetWindow = this._targetWindow;
        this.hide();
        this._onActivate(rec, targetWindow);
    }

    _clearNumberPick() {
        if (this._numberPickTimer) {
            try {
                GLib.Source.remove(this._numberPickTimer);
            } catch (e) {
                log.debug(`number pick cleanup failed: ${e.message}`);
            }
            this._numberPickTimer = 0;
        }
        this._numberPickBuffer = '';
        this._showNumberHint('');
    }

    _commitNumberPick() {
        const n = parseInt(this._numberPickBuffer, 10);
        this._clearNumberPick();
        if (n >= 1)
            this._activateRow(n - 1);
    }

    _previewNumberPick(n) {
        if (n >= 1 && n <= this._rows.length) {
            this._select(n - 1);
            this._showNumberHint(`Row ${n} selected - keep typing digits or wait to paste`);
        } else {
            this._showNumberHint(`No row ${this._numberPickBuffer}`, true);
        }
    }

    _onNumberPickDigit(digit) {
        if (this._numberPickBuffer === '' && digit === '0') {
            this._showNumberHint('Row 10');
            this._activateRow(9);
            return;
        }

        if (this._numberPickTimer) {
            try {
                GLib.Source.remove(this._numberPickTimer);
            } catch (e) {
                log.debug(`number pick cleanup failed: ${e.message}`);
            }
            this._numberPickTimer = 0;
        }

        this._numberPickBuffer += digit;
        const n = parseInt(this._numberPickBuffer, 10);
        const exact = n >= 1 && n <= this._rows.length;
        this._previewNumberPick(n);

        if (!exact)
            return;

        this._numberPickTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._numberPickTimeoutMs,
            () => {
                this._numberPickTimer = 0;
                this._commitNumberPick();
                return GLib.SOURCE_REMOVE;
            });
    }

    _onNumberPickBackspace() {
        if (this._numberPickBuffer === '')
            return false;

        if (this._numberPickTimer) {
            try {
                GLib.Source.remove(this._numberPickTimer);
            } catch (e) {
                log.debug(`number pick cleanup failed: ${e.message}`);
            }
            this._numberPickTimer = 0;
        }

        this._numberPickBuffer = this._numberPickBuffer.slice(0, -1);
        if (this._numberPickBuffer === '') {
            this._showNumberHint('');
            return true;
        }

        const n = parseInt(this._numberPickBuffer, 10);
        const exact = n >= 1 && n <= this._rows.length;
        this._previewNumberPick(n);

        if (exact) {
            this._numberPickTimer = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                this._numberPickTimeoutMs,
                () => {
                    this._numberPickTimer = 0;
                    this._commitNumberPick();
                    return GLib.SOURCE_REMOVE;
                });
        }

        return true;
    }

    _keyDigit(sym) {
        if (sym >= Clutter.KEY_0 && sym <= Clutter.KEY_9)
            return `${sym - Clutter.KEY_0}`;
        if (sym >= Clutter.KEY_KP_0 && sym <= Clutter.KEY_KP_9)
            return `${sym - Clutter.KEY_KP_0}`;
        return null;
    }

    _isCtrlF(event, sym) {
        const state = event.get_state();
        return sym === Clutter.KEY_f &&
            (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
    }

    _focusSearch() {
        if (!this._entry)
            return;
        this._clearNumberPick();
        global.stage.set_key_focus(this._entry.clutter_text);
    }

    _onKey(event) {
        if (!this._entry)
            return Clutter.EVENT_STOP;
        const sym = event.get_key_symbol();

        if (this._isCtrlF(event, sym)) {
            this._focusSearch();
            return Clutter.EVENT_STOP;
        }

        // Number quick-paste (1..N, standalone 0 => row 10) - only while the search box
        // is not focused. Ctrl+F moves focus into search. See docs/07-ui.md.
        if (global.stage.get_key_focus() !== this._entry.clutter_text) {
            if (sym === Clutter.KEY_BackSpace) {
                if (this._onNumberPickBackspace())
                    return Clutter.EVENT_STOP;
            }

            const digit = this._keyDigit(sym);
            if (digit !== null) {
                this._onNumberPickDigit(digit);
                return Clutter.EVENT_STOP;
            }
        }

        switch (sym) {
            case Clutter.KEY_Escape:
                this._clearNumberPick();
                this.hide();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                this._clearNumberPick();
                this._select(Math.min(this._selected + 1, this._rows.length - 1));
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
                this._clearNumberPick();
                this._select(Math.max(this._selected - 1, 0));
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Return:
            case Clutter.KEY_KP_Enter:
                if (this._numberPickBuffer !== '') {
                    this._commitNumberPick();
                    return Clutter.EVENT_STOP;
                }
                if (this._selected >= 0)
                    this._activate(this._rows[this._selected].rec);
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }
    }

    _onBackdropPress(event) {
        const source = event.get_source();
        if (!actorContains(this._panel, source)) {
            this.hide();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}
