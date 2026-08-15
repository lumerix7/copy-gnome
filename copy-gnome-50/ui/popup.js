import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { log } from '../core/log.js';
import { pasteWindowId } from '../core/paste.js';
import { Completions } from '../core/completions.js';
import { isRichRecord, plainTextPayload, uriListPayload } from '../core/payloads.js';
import { POPUP_PREVIEW_CHARS, recordPreview } from '../core/preview.js';

// Modal, searchable history list. See docs/07-ui.md. The grabbed actor is a full-monitor
// backdrop (so clicks outside the panel dismiss it); the panel itself is reactive so blank
// space inside the popup does not fall through as an outside click. The panel is centered on
// the active monitor. Near-caret anchoring was removed because GNOME/Wayland caret reporting
// is not reliable across apps or repeated modal grabs.

// Always-visible keyboard/mouse cheat sheet shown under the search box. Short, English +
// symbols. Number-pick feedback temporarily replaces it and restores it when cleared.
const HINT_TEXT = '↑↓/jk move · 1-n pick · enter/click paste · / search · esc close';
const SEARCH_HINT_TEXT = '↑↓ move · enter/click paste · type to filter · esc cancel';
const DEFAULT_UI = {
    popupWidth: 640,
    popupMaxHeight: 800,
    popupOffsetX: 0,
    popupOffsetY: 0,
    popupEdgeMargin: 8,
    popupOpacity: 0.92,
    popupTheme: 'auto',
    numberPickTimeoutMs: 500,
};
const POPUP_THEMES = new Set(['auto', 'dark', 'light']);
let interfaceSettings = null;

// Keyboard hint shown per row, matching the number quick-paste keys (1..N, 0 for the 10th).
// Hint shows the real row number (1..N). Pressing standalone `0` still selects row 10 - that
// key binding lives in _onNumberPickDigit and is unchanged; only this label was "0" → "10".
function rowHint(i) {
    return `${i + 1}`;
}

function kindClass(kind) {
    const normalized = String(kind ?? 'unknown').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'unknown';
    return `cg-kind cg-kind-${normalized}`;
}

function previewLabel(rec) {
    return recordPreview(rec, { max: POPUP_PREVIEW_CHARS });
}

function timeLabel(rec) {
    const micros = Number(rec.usedAt || rec.createdAt || 0);
    if (!Number.isFinite(micros) || micros <= 0)
        return '';
    try {
        const ageUs = Math.max(0, GLib.get_real_time() - micros);
        const minuteUs = 60 * 1000000;
        const hourUs = 60 * minuteUs;
        const dayUs = 24 * hourUs;
        const minutes = Math.floor(ageUs / minuteUs);
        if (minutes < 1)
            return 'now';
        if (minutes < 60)
            return `${minutes}m`;
        const hours = Math.floor(ageUs / hourUs);
        if (hours < 24)
            return `${hours}h`;
        const days = Math.floor(ageUs / dayUs);
        if (days <= 99)
            return `${Math.max(1, days)}d`;
        return '99+d';
    } catch (e) {
        return '';
    }
}

function timeColumnLabel(rec) {
    return timeLabel(rec).padStart(4, ' ');
}

function matches(rec, query) {
    if (!query) return true;
    const hay = (
        plainTextPayload(rec)?.value ||
        uriListPayload(rec)?.value ||
        rec.kind ||
        ''
    ).toLowerCase();
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

function eventInsideActor(actor, event) {
    if (!actor)
        return false;
    const coords = event?.get_coords();
    if (!coords)
        return false;
    const [x, y] = coords;
    const [actorX, actorY] = actor.get_transformed_position();
    const [actorW, actorH] = actor.get_transformed_size();
    return x >= actorX && x <= actorX + actorW &&
        y >= actorY && y <= actorY + actorH;
}

function setMoveCursor(actor) {
    if (!actor?.set_cursor || !Clutter.Cursor)
        return;
    try {
        const cursor = Clutter.Cursor.MOVE ?? Clutter.Cursor.DND_MOVE ?? Clutter.Cursor.POINTING_HAND;
        if (cursor !== undefined)
            actor.set_cursor(cursor);
    } catch (e) {
        log.debug('move cursor unavailable', e);
    }
}

function uiDefaults(ui) {
    return { ...DEFAULT_UI, ...(ui ?? {}) };
}

function interfaceColorScheme() {
    try {
        if (!interfaceSettings)
            interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        return interfaceSettings.get_string('color-scheme') || 'unknown';
    } catch (e) {
        log.debug('[popup]: gsettings color-scheme unavailable', e);
        return 'unknown';
    }
}

function resolvedThemeForColorScheme(colorScheme) {
    return colorScheme === 'prefer-light' ? 'light' : 'dark';
}

function resolvePopupTheme(ui) {
    const theme = POPUP_THEMES.has(ui?.popupTheme) ? ui.popupTheme : DEFAULT_UI.popupTheme;
    const gsettingsColorScheme = interfaceColorScheme();
    const shellColorScheme = Main.sessionMode?.colorScheme ?? 'unknown';
    const colorScheme = gsettingsColorScheme !== 'unknown' ? gsettingsColorScheme : shellColorScheme;
    if (theme !== 'auto')
        return { configured: theme, gsettingsColorScheme, shellColorScheme, resolved: theme };
    return {
        configured: theme,
        gsettingsColorScheme,
        shellColorScheme,
        resolved: resolvedThemeForColorScheme(colorScheme),
    };
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
        log.debug('monitorForActor failed', e);
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

function cleanupPopupStep(stage, action) {
    try {
        action();
    } catch (error) {
        log.error(`[popup]: ${stage} cleanup failed`, error);
    }
}

function removePopupActor(stage, actor) {
    if (!actor)
        return;
    cleanupPopupStep(`${stage} input`, () => { actor.reactive = false; });
    cleanupPopupStep(`${stage} visibility`, () => actor.hide());
    cleanupPopupStep(`${stage} detach`, () => actor.get_parent()?.remove_child(actor));
    cleanupPopupStep(`${stage} destroy`, () => actor.destroy());
}

export class Popup {
    constructor({ getItems, onActivate, onRemove, onClear, onSave, onSaveRecord, onRevealFile, getUi }) {
        this._getItems = getItems;
        this._onActivate = onActivate;
        this._onRemove = onRemove ?? (() => {});
        this._onClear = onClear ?? (() => {});
        this._onSave = onSave ?? (() => 'idle');
        this._onSaveRecord = onSaveRecord ?? (() => {});
        this._onRevealFile = onRevealFile ?? (() => {});
        this._getUi = getUi ?? (() => null);

        this._view = null;
        this._backdrop = null;
        this._panel = null;
        this._entry = null;
        this._hint = null;
        this._hintVersion = 0;
        this._scrollView = null;
        this._listBox = null;
        this._itemMenu = null;
        this._itemMenuActions = null;
        this._dragHandle = null;
        this._grab = null;
        this._rows = [];        // [{rec, button}]
        this._selected = -1;
        this._visible = false;
        this._numberPickBuffer = '';
        this._numberPickRecordId = null;
        this._cancelNumberPickTimeout = null;
        this._targetWindowId = null;
        this._anchorActor = null;
        this._clearBtn = null;
        this._clearArmed = false;
        this._cancelClearConfirmTimeout = null;
        this._cancelSaveHintTimeout = null;
        this._drag = null;
        this._moveBounds = null;
        this._popupTheme = 'dark';
        this._localHistoryMutation = false;
    }

    get visible() { return this._visible; }

    refresh() {
        if (!this._visible || this._localHistoryMutation)
            return;
        const selectedId = this._rows[this._selected]?.rec?.id ?? null;
        const fallbackIndex = this._selected;
        if (!this._rebuild() || this._rows.length === 0)
            return;
        let next = selectedId == null
            ? -1
            : this._rows.findIndex(row => row.rec?.id === selectedId);
        if (next < 0)
            next = Math.min(Math.max(fallbackIndex, 0), this._rows.length - 1);
        this._select(next);
        log.debug(`[popup]: history refreshed rows=${this._rows.length} selected=${next + 1} selectedId=${this._rows[next]?.rec?.id ?? '(none)'}`);
    }

    // opts: { placement: 'center'|'panel', anchorActor }. The ONLY difference between the
    // two callers is placement; both share the same translucent styling and all logic.
    toggle(targetWindow = null, opts = {}) {
        if (this._visible) this.hide('toggle');
        else this.show(targetWindow, opts);
    }

    show(targetWindow = null, opts = {}) {
        if (this._visible) return;

        this.retireView();
        this._view = new Completions();
        try {
        this._targetWindowId = pasteWindowId(targetWindow ??
            global.display.get_focus_window?.() ?? global.display.focus_window);
        const placement = opts.placement === 'panel' ? 'panel' : 'center';
        const movable = placement === 'center';
        const anchorActor = opts.anchorActor ?? null;
        this._anchorActor = anchorActor;
        const ui = uiDefaults(this._getUi());
        let width = num(ui.popupWidth, DEFAULT_UI.popupWidth, 240, 8000);
        let maxHeight = num(ui.popupMaxHeight, DEFAULT_UI.popupMaxHeight, 120, 8000);
        const edgeMargin = num(ui.popupEdgeMargin, DEFAULT_UI.popupEdgeMargin, 0, 96);
        const opacity = num(ui.popupOpacity, DEFAULT_UI.popupOpacity, 0.1, 1);
        const theme = resolvePopupTheme(ui);
        this._popupTheme = theme.resolved;
        log.debug(`[popup]: theme configured=${theme.configured} gsettingsColorScheme=${theme.gsettingsColorScheme} shellColorScheme=${theme.shellColorScheme} resolved=${theme.resolved}`);
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

        // GNOME 48 deprecated St widget `vertical`; use `orientation` (forward-compatible).
        this._panel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: `cg-popup cg-popup-${theme.resolved}`,
            reactive: true,
            width,
        });
        this._panel.opacity = Math.round(opacity * 255);
        this._backdrop.add_child(this._panel);

        const dragMotion = this._pointerSignal('drag motion', this._updateDrag);
        const dragRelease = this._pointerSignal('drag release', this._finishDrag);
        if (movable) {
            this._dragHandle = new St.Widget({
                style_class: 'cg-drag-handle',
                reactive: true,
                can_focus: false,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                width: 80,
                height: 7,
            });
            this._dragHandle.connect('button-press-event',
                this._pointerSignal('drag start', this._startDrag));
            this._dragHandle.connect('motion-event',
                dragMotion);
            this._dragHandle.connect('button-release-event',
                dragRelease);
            setMoveCursor(this._dragHandle);
            this._panel.add_child(this._dragHandle);
        }

        this._entry = new St.Entry({
            style_class: 'cg-search',
            hint_text: 'Search clipboard... ',
            can_focus: true,
            x_expand: true,
        });
        this._panel.add_child(this._entry);

        this._hint = new St.Label({
            text: HINT_TEXT,
            style_class: 'cg-number-hint',
            visible: true,
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
        this._listBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'cg-list',
        });
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
        // GNOME 50's Clutter.grab() modal routes crossing (enter/leave) events to the
        // grabbed backdrop, so descendant St.Buttons never flip `hover` true and therefore
        // never emit `clicked` (the release is gated on hover). Press events ARE still
        // delivered to descendants (see _onBackdropPress), so drive the two-step confirm off
        // button-press-event. This is the only mouse-only control, hence the only regression.
        this._clearBtn.connect('button-press-event', this._pointerSignal('clear history', event => {
            const pointerButton = event.get_button();
            if (pointerButton !== Clutter.BUTTON_PRIMARY) {
                if (pointerButton === Clutter.BUTTON_SECONDARY)
                    log.debug('[popup]: clear secondary click ignored; context menu pending');
                return Clutter.EVENT_STOP;
            }
            this._onClearClicked();
            return Clutter.EVENT_STOP;
        }));
        footer.add_child(this._clearBtn);
        this._panel.add_child(footer);

        Main.layoutManager.uiGroup.add_child(this._backdrop);

        this._entry.clutter_text.connect('text-changed', this._view.onSignal('popup search text-changed', () => {
            if (this._rebuild())
                this._showNumberHint('');
        }));
        this._entry.clutter_text.connect('key-focus-in',
            this._view.onSignal('popup search key-focus-in', () => this._onSearchFocusIn()));
        this._entry.clutter_text.connect('key-focus-out',
            this._view.onIdle('popup focus hint', () => this._showNumberHint('')));
        this._entry.clutter_text.connect('key-press-event',
            (_ct, event) => this._onKey(event));
        this._backdrop.connect('key-press-event',
            (_a, event) => this._onKey(event));
        this._backdrop.connect('button-press-event',
            this._pointerSignal('backdrop press', this._onBackdropPress));
        this._backdrop.connect('motion-event',
            dragMotion);
        this._backdrop.connect('button-release-event',
            dragRelease);
        this._panel.connect('motion-event',
            dragMotion);
        this._panel.connect('button-release-event',
            dragRelease);

        if (!this._rebuild())
            return;

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
        this._moveBounds = movable
            ? {
                minX: edgeMargin,
                maxX: monitor.width - width - edgeMargin,
                minY: edgeMargin,
                maxY: monitor.height - natH - edgeMargin,
            }
            : null;
        lx = clamp(lx, edgeMargin, monitor.width - width - edgeMargin);
        ly = clamp(ly, edgeMargin, monitor.height - natH - edgeMargin);
        this._panel.set_position(Math.round(lx), Math.round(ly));

        this._grab = Main.pushModal(this._backdrop, { actionMode: Shell.ActionMode.POPUP });
        if (!this._grab) {
            log.warn('failed to grab input for popup');
            this.hide('grab-failed');
            return;
        }
        this._visible = true;
        log.debug(`[popup]: show placement=${placement} movable=${movable ? 'yes' : 'no'} position=${Math.round(lx)},${Math.round(ly)} size=${width}x${Math.round(natH)}`);
        global.stage.set_key_focus(this._backdrop);
        } catch (e) {
            log.error('popup show failed', e);
            this.hide('show-failed');
        }
    }

    _pointerSignal(stage, handle, scope = this._view) {
        const view = this._view;
        return scope.onSignal(`[popup]: ${stage}`, (_actor, event) => {
            if (this._view !== view || (scope !== view && scope !== this._itemMenuActions))
                return Clutter.EVENT_STOP;
            try {
                return handle.call(this, event);
            } catch (error) {
                log.error(`[popup]: ${stage}`, error);
                if (this._view === view)
                    cleanupPopupStep('failed pointer event', () => this.hide('pointer-error'));
                return Clutter.EVENT_STOP;
            }
        }, Clutter.EVENT_STOP);
    }

    retireView() {
        const view = this._view;
        this._view = null;
        cleanupPopupStep('item menu actions', () => this._itemMenuActions?.close());
        view?.close();
    }

    hide(reason = 'programmatic') {
        const grab = this._grab;
        const backdrop = this._backdrop;
        if (this._visible || backdrop)
            log.debug(`[popup]: hide reason=${reason}`);
        cleanupPopupStep('view', () => this.retireView());
        this._grab = null;
        this._backdrop = null;
        this._hint = null;
        this._clearBtn = null;
        cleanupPopupStep('number pick', () => this._resetNumberPickState());
        cleanupPopupStep('clear confirmation', () => this._disarmClear());
        cleanupPopupStep('save hint', () => this._clearSaveHint());
        cleanupPopupStep('item menu', () => this._clearItemContextMenu());
        if (grab)
            cleanupPopupStep('modal release', () => Main.popModal(grab));
        removePopupActor('backdrop', backdrop);

        this._panel = null;
        this._entry = null;
        this._scrollView = null;
        this._listBox = null;
        this._itemMenu = null;
        this._dragHandle = null;
        this._rows = [];
        this._selected = -1;
        this._targetWindowId = null;
        this._anchorActor = null;
        this._drag = null;
        this._moveBounds = null;
        this._popupTheme = 'dark';
        this._visible = false;
    }

    _setDragTranslation(x, y) {
        if (!this._panel || !this._moveBounds)
            return;
        const b = this._moveBounds;
        const nextX = Math.round(clamp(x, b.minX, b.maxX));
        const nextY = Math.round(clamp(y, b.minY, b.maxY));
        this._panel.translation_x = nextX - this._drag.panelX;
        this._panel.translation_y = nextY - this._drag.panelY;
    }

    _commitDragPosition() {
        if (!this._panel || !this._drag)
            return null;
        const x = Math.round(this._drag.panelX + (this._panel.translation_x ?? 0));
        const y = Math.round(this._drag.panelY + (this._panel.translation_y ?? 0));
        this._panel.translation_x = 0;
        this._panel.translation_y = 0;
        this._panel.set_position(x, y);
        return [x, y];
    }

    _startDrag(event) {
        if (!this._panel || !this._moveBounds)
            return Clutter.EVENT_PROPAGATE;
        const coords = event?.get_coords();
        if (!coords)
            return Clutter.EVENT_STOP;
        const [stageX, stageY] = coords;
        const [panelX, panelY] = this._panel.get_position();
        this._panel.translation_x = 0;
        this._panel.translation_y = 0;
        this._panel.add_style_class_name('cg-popup-dragging');
        this._drag = { stageX, stageY, panelX, panelY };
        return Clutter.EVENT_STOP;
    }

    _updateDrag(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const coords = event?.get_coords();
        if (!coords)
            return Clutter.EVENT_STOP;
        const [stageX, stageY] = coords;
        this._setDragTranslation(
            this._drag.panelX + stageX - this._drag.stageX,
            this._drag.panelY + stageY - this._drag.stageY);
        return Clutter.EVENT_STOP;
    }

    _finishDrag(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        this._updateDrag(event);
        const position = this._commitDragPosition();
        this._panel?.remove_style_class_name('cg-popup-dragging');
        this._drag = null;
        if (position) {
            const [x, y] = position;
            log.debug(`[popup]: drag end position=${Math.round(x)},${Math.round(y)}`);
        }
        return Clutter.EVENT_STOP;
    }

    _onClearClicked() {
        // Two-step confirm. We already hold a modal grab, so opening a separate confirm
        // dialog would mean nesting grabs; instead the first click arms + relabels the
        // button and the second click (within 3s) actually clears.
        if (!this._view)
            return;
        if (!this._clearArmed) {
            this._cancelClearConfirmTimeout = this._view.after('popup clear confirmation', 3000, () => {
                this._cancelClearConfirmTimeout = null;
                this._disarmClear();
            });
            if (!this._cancelClearConfirmTimeout)
                return;
            this._clearArmed = true;
            try {
                if (this._clearBtn) {
                    this._clearBtn.add_style_class_name('cg-clear-armed');
                    this._clearBtn.label = 'Click again to clear all';
                }
            } catch (error) {
                log.error('[popup]: show clear confirmation', error);
                this._disarmClear();
            }
            return;
        }

        this._disarmClear();
        this._clearItemContextMenu();
        this._localHistoryMutation = true;
        try {
            this._onClear();
        } catch (e) {
            log.error('popup clear failed', e);
        } finally {
            this._localHistoryMutation = false;
        }
        // Reset the filter so the now-empty history shows "(empty)", not "(no matches)".
        this._entry?.set_text('');
        this._rebuild();
    }

    _disarmClear() {
        this._clearArmed = false;
        const cancel = this._cancelClearConfirmTimeout;
        this._cancelClearConfirmTimeout = null;
        cancel?.();
        if (this._clearBtn) {
            try {
                this._clearBtn.remove_style_class_name('cg-clear-armed');
                this._clearBtn.label = 'Clear history';
            } catch (e) {
                log.error('[popup]: reset clear confirmation', e);
            }
        }
    }

    _rebuild() {
        const view = this._view;
        if (!view)
            return false;
        try {
            const query = this._entry.get_text();
            const items = this._getItems().filter(rec => matches(rec, query));
            this._replaceRows(items, query);
            return this._view === view;
        } catch (error) {
            log.error('popup search rebuild failed', error);
            if (this._view === view)
                this.hide('search-rebuild-failed');
            return false;
        }
    }

    _replaceRows(items, query) {
        this._rows = [];
        this._selected = -1;
        this._clearItemContextMenu();
        this._listBox.destroy_all_children();
        if (items.length === 0) {
            // (no matches) only when a search filtered everything out; otherwise the
            // history is genuinely empty.
            const text = query ? '(no matches)' : '(empty)';
            const empty = new St.Label({ text, style_class: 'cg-empty' });
            this._listBox.add_child(empty);
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
            const label = new St.Label({ text: previewLabel(rec), style_class: 'cg-preview', x_expand: true });
            label.clutter_text.set_single_line_mode(true);
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            box.add_child(label);
            const kind = new St.Label({ text: rec.kind, style_class: kindClass(rec.kind) });
            box.add_child(kind);
            box.add_child(new St.Label({ text: timeColumnLabel(rec), style_class: 'cg-time' }));
            button.set_child(box);

            // Single click selects then pastes. Hover only tints the row via CSS `:hover`; it
            // deliberately does NOT move the keyboard selection, so a mouse resting near the
            // list can't fight arrow-key / number navigation. We use button-press-event rather
            // than St.Button's `clicked`: under GNOME 50's modal grab the backdrop swallows
            // crossing events, so `hover` never goes true and `clicked` never fires (same root
            // cause as the Clear button below).
            button.connect('button-press-event', (actor, event) => this._onRowPress(i, actor, event));
            this._listBox.add_child(button);
            this._rows.push({ rec, button });
        });

        this._select(0);
    }

    _onRowPress(i, button, event) {
        const row = this._rows[i];
        if (!this._view || row?.button !== button)
            return Clutter.EVENT_STOP;
        try {
            const which = event.get_button();
            if (which === Clutter.BUTTON_SECONDARY) {
                this._select(i);
                this._showItemContextMenu(row.rec, button, event);
            } else if (which === Clutter.BUTTON_PRIMARY) {
                this._clearItemContextMenu();
                this._select(i);
                this._activate(row.rec);
            }
        } catch (error) {
            log.error('popup row button-press-event', error);
            this._clearItemContextMenu();
        }
        return Clutter.EVENT_STOP;
    }

    _itemMenuButton(label, action, styleClass = '') {
        const button = new St.Button({
            style_class: `cg-item-menu-button${styleClass ? ` ${styleClass}` : ''}`,
            label,
            can_focus: false,
            x_expand: true,
        });
        button.connect('button-press-event', this._pointerSignal('item menu action', event => {
            if (event.get_button() === Clutter.BUTTON_PRIMARY)
                action();
            return Clutter.EVENT_STOP;
        }, this._itemMenuActions));
        return button;
    }

    _showItemContextMenu(rec, rowButton, event) {
        if (!this._backdrop)
            return;
        this._clearNumberPick();
        this._disarmClear();
        this._clearItemContextMenu();

        const menu = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: `cg-item-menu cg-item-menu-${this._popupTheme}`,
            reactive: true,
            can_focus: false,
        });
        this._itemMenu = menu;
        this._itemMenuActions = new Completions();
        menu.add_child(this._itemMenuButton('Paste', () => this._activate(rec)));
        if (isRichRecord(rec)) {
            menu.add_child(this._itemMenuButton('Paste plain',
                () => this._activate(rec, { mode: 'plain' })));
        }
        if (rec.kind !== 'file') {
            menu.add_child(this._itemMenuButton('Save as',
                () => this._saveItemAs(rec)));
        }
        if (rec.kind === 'file') {
            menu.add_child(this._itemMenuButton('Paste path',
                () => this._activate(rec, { mode: 'path' })));
            menu.add_child(this._itemMenuButton('Show in Files',
                () => this._revealItem(rec)));
        }
        menu.add_child(this._itemMenuButton('Remove', () => this._removeItem(rec),
            'cg-item-menu-danger'));
        this._backdrop.add_child(menu);

        this._positionItemContextMenu(menu, rowButton, event);
        log.debug(`[popup]: item context menu opened recordId=${rec.id ?? '(none)'} kind=${rec.kind ?? '(none)'}`);
    }

    _positionItemContextMenu(menu, rowButton, event) {
        const margin = 6;
        let x = margin;
        let y = margin;
        const coords = event?.get_coords();

        try {
            const [backdropX, backdropY] = this._backdrop.get_transformed_position();
            if (coords) {
                x = coords[0] - backdropX;
                y = coords[1] - backdropY;
            } else if (rowButton) {
                const [rowX, rowY] = rowButton.get_transformed_position();
                const [, rowH] = rowButton.get_transformed_size();
                x = rowX - backdropX + 12;
                y = rowY - backdropY + rowH;
            }

            const [minW, natW] = menu.get_preferred_width(-1);
            const [minH, natH] = menu.get_preferred_height(natW);
            const width = Math.max(120, Math.ceil(natW || minW || 120));
            const height = Math.max(1, Math.ceil(natH || minH || 1));
            const maxX = Math.max(margin, this._backdrop.width - width - margin);
            const maxY = Math.max(margin, this._backdrop.height - height - margin);
            menu.set_width(width);
            menu.set_position(Math.round(clamp(x, margin, maxX)),
                Math.round(clamp(y, margin, maxY)));
        } catch (e) {
            log.debug('popup item menu position failed', e);
            menu.set_position(x, y);
        }
    }

    _clearItemContextMenu() {
        const menu = this._itemMenu;
        const actions = this._itemMenuActions;
        this._itemMenu = null;
        this._itemMenuActions = null;
        cleanupPopupStep('item menu actions', () => actions?.close());
        removePopupActor('item menu', menu);
    }

    _saveItemAs(rec) {
        this._clearItemContextMenu();
        // Hide before delegating: the popup's modal grab would sit in front of the portal
        // save dialog and swallow its input.
        log.debug(`[popup]: save as selected recordId=${rec?.id ?? '(none)'} kind=${rec?.kind ?? '(none)'}`);
        this.hide('save-as');
        try {
            this._onSaveRecord(rec);
        } catch (e) {
            log.error('popup save as failed', e);
        }
    }

    _revealItem(rec) {
        this._clearItemContextMenu();
        // The popup stays open while the handler checks existence: a stale record shows
        // the inline hint here; when something exists the handler hides the popup itself
        // before the file manager takes focus.
        log.debug(`[popup]: reveal selected recordId=${rec?.id ?? '(none)'} kind=${rec?.kind ?? '(none)'}`);
        try {
            if (this._view)
                this._onRevealFile(rec, this._view, () => this._showSaveHint('File not found', true));
        } catch (error) {
            log.error('popup reveal failed', error);
        }
    }

    _removeItem(rec) {
        if (!rec?.id) {
            log.warn('popup item remove skipped: missing record id');
            this._clearItemContextMenu();
            return;
        }
        const recordId = rec.id;
        this._clearItemContextMenu();
        this._localHistoryMutation = true;
        try {
            this._onRemove(rec);
            log.debug(`[popup]: item removed recordId=${recordId}`);
        } catch (e) {
            log.error(`popup item remove failed recordId=${recordId}`, e);
        } finally {
            this._localHistoryMutation = false;
        }
        this._rebuild();
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
            log.debug('scroll selected row failed', e);
        }
    }

    _showNumberHint(text, warning = false) {
        if (!this._hint)
            return;
        const version = ++this._hintVersion;
        // Empty text restores the always-on cheat sheet rather than hiding the row.
        if (warning)
            this._hint.add_style_class_name('cg-number-hint-warning');
        else
            this._hint.remove_style_class_name('cg-number-hint-warning');
        this._hint.set_text(text === '' ? this._defaultHintText() : text);
        this._hint.visible = true;
        return version;
    }

    _defaultHintText() {
        return this._isSearchMode() ? SEARCH_HINT_TEXT : HINT_TEXT;
    }

    _isSearchMode() {
        if (!this._entry)
            return false;
        return global.stage.get_key_focus() === this._entry.clutter_text ||
            this._entry.get_text() !== '';
    }

    _onSearchFocusIn() {
        this._clearNumberPick();
        this._showNumberHint('');
    }

    _activateRow(i) {
        if (i < 0 || i >= this._rows.length)
            return;
        this._select(i);
        this._activate(this._rows[i].rec);
    }

    _activate(rec, opts = {}) {
        const windowId = this._targetWindowId;
        this._clearItemContextMenu();
        this.hide('activate');
        this._onActivate(rec, windowId, opts);
    }

    _cancelNumberPick() {
        const cancel = this._cancelNumberPickTimeout;
        this._cancelNumberPickTimeout = null;
        cancel?.();
    }

    _resetNumberPickState() {
        this._numberPickBuffer = '';
        this._numberPickRecordId = null;
        this._cancelNumberPick();
    }

    _clearNumberPick() {
        this._resetNumberPickState();
        this._showNumberHint('');
    }

    _clearSaveHint() {
        const cancel = this._cancelSaveHintTimeout;
        this._cancelSaveHintTimeout = null;
        cancel?.();
    }

    _showSaveHint(text, warning = false) {
        this._clearSaveHint();
        let version;
        const cancel = this._view?.after('popup save hint', 1500, () => {
            this._cancelSaveHintTimeout = null;
            if (this._hintVersion === version)
                this._showNumberHint('');
        });
        if (!cancel)
            return;
        this._cancelSaveHintTimeout = cancel;
        try {
            version = this._showNumberHint(text, warning);
        } catch (error) {
            log.error('[popup]: show save hint', error);
            if (this._cancelSaveHintTimeout === cancel)
                this._clearSaveHint();
        }
    }

    _saveHintForStatus(status) {
        switch (status) {
            case 'saved':
                return { text: 'History saved', warning: false };
            case 'busy':
                return { text: 'Save already in progress', warning: true };
            case 'idle':
                return { text: 'History already saved', warning: false };
            default:
                return { text: 'History save failed', warning: true };
        }
    }

    _commitNumberPick() {
        const id = this._numberPickRecordId;
        this._clearNumberPick();
        if (id === null)
            return;
        const row = this._rows.find(item => item.rec.id === id);
        if (row)
            this._activate(row.rec);
        else
            log.debug(`[popup]: number pick cancelled reason=record-removed recordId=${id}`);
    }

    _previewNumberPick(n) {
        if (n >= 1 && n <= this._rows.length) {
            this._select(n - 1);
            this._showNumberHint(`Row ${n} selected - keep typing digits or wait to paste`);
        } else {
            this._showNumberHint(`No row ${this._numberPickBuffer}`, true);
        }
    }

    _updateNumberPick(digits) {
        this._cancelNumberPick();
        this._numberPickBuffer = digits;
        const n = parseInt(digits, 10);
        this._numberPickRecordId = this._rows[n - 1]?.rec.id ?? null;
        if (!digits) {
            this._showNumberHint('');
            return;
        }

        this._previewNumberPick(n);
        if (this._numberPickRecordId !== null) {
            this._cancelNumberPickTimeout = this._view?.after('popup number pick', this._numberPickTimeoutMs, () => {
                this._cancelNumberPickTimeout = null;
                this._commitNumberPick();
            });
        }
    }

    _onNumberPickDigit(digit) {
        if (this._numberPickBuffer === '' && digit === '0') {
            this._showNumberHint('Row 10');
            this._activateRow(9);
            return;
        }
        this._updateNumberPick(this._numberPickBuffer + digit);
    }

    _onNumberPickBackspace() {
        if (this._numberPickBuffer === '')
            return false;
        this._updateNumberPick(this._numberPickBuffer.slice(0, -1));
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

    _isCtrlS(event, sym) {
        const state = event.get_state();
        return sym === Clutter.KEY_s &&
            (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
    }

    _hasCommandModifier(event) {
        const state = event.get_state();
        const masks = [
            Clutter.ModifierType.CONTROL_MASK,
            Clutter.ModifierType.MOD1_MASK,
            Clutter.ModifierType.META_MASK,
            Clutter.ModifierType.SUPER_MASK,
            Clutter.ModifierType.HYPER_MASK,
            Clutter.ModifierType.MOD4_MASK,
        ].filter(mask => typeof mask === 'number');
        return masks.some(mask => (state & mask) !== 0);
    }

    _isSearchFocused() {
        return global.stage.get_key_focus() === this._entry?.clutter_text;
    }

    _focusSearch() {
        if (!this._entry)
            return;
        this._clearNumberPick();
        global.stage.set_key_focus(this._entry.clutter_text);
        this._showNumberHint('');
    }

    _cancelSearch() {
        if (!this._entry || !this._isSearchMode())
            return false;
        this._clearNumberPick();
        if (this._entry.get_text() !== '')
            this._entry.set_text('');
        if (this._backdrop)
            global.stage.set_key_focus(this._backdrop);
        this._showNumberHint('');
        return true;
    }

    _onKey(event) {
        try {
            return this._handleKeyPress(event);
        } catch (error) {
            log.error('[popup]: key-press-event', error);
            cleanupPopupStep('number pick after key error', () => this._resetNumberPickState());
            return Clutter.EVENT_STOP;
        }
    }

    _handleKeyPress(event) {
        if (!this._entry)
            return Clutter.EVENT_STOP;
        const sym = event.get_key_symbol();

        if (this._isCtrlF(event, sym)) {
            this._focusSearch();
            return Clutter.EVENT_STOP;
        }
        if (this._isCtrlS(event, sym)) {
            cleanupPopupStep('pre-save number pick', () => this._resetNumberPickState());
            cleanupPopupStep('pre-save hint', () => this._showNumberHint(''));
            const view = this._view;
            const version = this._hintVersion;
            const showResult = status => {
                if (!view || view !== this._view || version !== this._hintVersion) {
                    log.debug('[popup]: skipped superseded save hint');
                    return;
                }
                const hint = this._saveHintForStatus(status);
                this._showSaveHint(hint.text, hint.warning);
            };
            try {
                view?.add('popup save', this._onSave(), result => showResult(result.ok ? result.value : 'failed'));
            } catch (error) {
                log.error('popup save failed', error);
                showResult('failed');
            }
            return Clutter.EVENT_STOP;
        }

        // Plain character shortcuts are active only outside the search box. Once search is
        // focused, '/', 'j', and 'k' are ordinary query text.
        const searchFocused = this._isSearchFocused();
        if (!searchFocused && !this._hasCommandModifier(event)) {
            if (sym === Clutter.KEY_slash) {
                this._focusSearch();
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_j) {
                this._clearNumberPick();
                this._select(Math.min(this._selected + 1, this._rows.length - 1));
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_k) {
                this._clearNumberPick();
                this._select(Math.max(this._selected - 1, 0));
                return Clutter.EVENT_STOP;
            }
        }

        // Number quick-paste (1..N, standalone 0 => row 10) - only while the search box
        // is not focused. '/' or Ctrl+F moves focus into search. See docs/07-ui.md.
        if (!searchFocused) {
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
                if (this._cancelSearch())
                    return Clutter.EVENT_STOP;
                this.hide('escape');
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Home:
            case Clutter.KEY_KP_Home:
                if (searchFocused)
                    return Clutter.EVENT_PROPAGATE;
                this._clearNumberPick();
                if (this._rows.length === 0)
                    return Clutter.EVENT_STOP;
                this._select(0);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_End:
            case Clutter.KEY_KP_End:
                if (searchFocused)
                    return Clutter.EVENT_PROPAGATE;
                this._clearNumberPick();
                if (this._rows.length === 0)
                    return Clutter.EVENT_STOP;
                this._select(this._rows.length - 1);
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
        if (actorContains(this._itemMenu, source))
            return Clutter.EVENT_PROPAGATE;
        if (eventInsideActor(this._itemMenu, event))
            return Clutter.EVENT_STOP;
        this._clearItemContextMenu();
        if (actorContains(this._panel, source))
            return Clutter.EVENT_PROPAGATE;
        if (eventInsideActor(this._panel, event))
            return Clutter.EVENT_STOP;
        this.hide('outside');
        return Clutter.EVENT_STOP;
    }
}
