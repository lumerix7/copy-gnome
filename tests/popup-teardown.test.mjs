import assert from 'node:assert/strict';
import test from 'node:test';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

function holdTimers(t) {
    const timers = [];
    const previous = { add: GLib.timeout_add, source: GLib.Source };
    GLib.timeout_add = (_priority, _ms, callback) => timers.push(callback);
    GLib.Source = { remove() { throw new Error('injected source removal failure'); } };
    t.after(() => {
        GLib.timeout_add = previous.add;
        GLib.Source = previous.source;
    });
    return timers;
}

function attachHint(popup) {
    popup._defaultHintText = () => '';
    popup._hint = {
        set_text(text) { this.text = text; },
        add_style_class_name() {},
        remove_style_class_name() {},
    };
    return popup._hint;
}

for (const version of [46, 50]) {
    test(`GNOME ${version} retired menu actions cannot restore their old record`, async t => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        class Menu {
            constructor() { this.children = []; this.reactive = this.visible = true; }
            add_child(child) { this.children.push(child); }
            hide() { this.visible = false; }
            get_parent() { return this.parent; }
            destroy() { throw new Error('injected menu destruction failure'); }
        }
        St.BoxLayout = Menu;
        St.Button = class { connect(_name, callback) { this.press = callback; } };
        Clutter.Orientation = { VERTICAL: 1 };
        t.after(() => { delete St.BoxLayout; delete St.Button; delete Clutter.Orientation; });
        const popup = new Popup({});
        const activated = [], removed = [];
        popup._view = new Completions();
        popup._backdrop = { add_child(m) { m.parent = this; }, remove_child(m) { m.parent = null; } };
        popup._positionItemContextMenu = () => {};
        popup._activate = rec => activated.push(rec.id);
        popup._removeItem = rec => removed.push(rec.id);
        const primary = { get_button: () => Clutter.BUTTON_PRIMARY };
        popup._showItemContextMenu({ id: 'A', kind: 'text' }, null, null);
        const old = popup._itemMenu;
        popup._clearItemContextMenu();
        popup._showItemContextMenu({ id: 'B', kind: 'text' }, null, null);
        for (const button of old.children)
            assert.equal(button.press(null, primary), Clutter.EVENT_STOP);
        assert.deepEqual(activated, []);
        assert.deepEqual(removed, []);
        assert.equal(old.visible, false);
        assert.equal(old.reactive, false);
        assert.equal(old.get_parent(), null);
        popup._itemMenu.children[0].press(null, primary);
        assert.deepEqual(activated, ['B']);
        popup._clearItemContextMenu();
        popup.retireView();
    });

    test(`GNOME ${version} pointer faults stop dispatch and release the modal grab`, async t => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        const { log } = await import(`../copy-gnome-${version}/core/log.js`);
        const errors = t.mock.method(log, 'error', () => {});
        const cleared = t.mock.fn();
        const popup = new Popup({ onClear: cleared });
        const failure = new Error('injected pointer failure');
        const fail = () => { throw failure; };
        for (const [stage, handler, event] of [
            ['backdrop press', popup._onBackdropPress, { get_source: fail }],
            ['drag start', popup._startDrag, { get_coords: () => [3, 4] }],
            ['clear history', popup._onClearClicked, {}],
        ]) {
            popup._panel = { get_position: fail };
            popup._moveBounds = {};
            popup._entry = { set_text: fail };
            popup._clearArmed = true;
            popup._visible = true;
            popup._view = new Completions();
            const release = t.mock.fn();
            popup._grab = { release };
            const motion = popup._pointerSignal('drag motion', popup._updateDrag);
            assert.equal(motion(null, {}), Clutter.EVENT_PROPAGATE, 'idle pointer motion must still propagate');
            const dispatch = popup._pointerSignal(stage, handler);
            assert.equal(dispatch(null, event), Clutter.EVENT_STOP);
            assert.equal(popup.visible, false);
            assert.equal(release.mock.callCount(), 1);
            assert.equal(dispatch(null, event), Clutter.EVENT_STOP, 'a retired signal must have no side effects');
            assert.ok(errors.mock.calls.some(call => call.arguments[0].includes(stage) && call.arguments[1] === failure));
        }
        assert.equal(cleared.mock.callCount(), 1, 'post-clear failure must not replay the clear action');
    });

    test(`GNOME ${version} a failed result rebuild closes the view and releases input`, async t => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        const { log } = await import(`../copy-gnome-${version}/core/log.js`);
        const errors = t.mock.method(log, 'error', () => {});
        const timers = holdTimers(t);
        const activate = t.mock.fn();
        const popup = new Popup({ getItems: () => [], onActivate: activate });
        const release = t.mock.fn(), destroy = t.mock.fn();
        const failure = new Error('injected search rebuild failure');
        popup._entry = { get_text: () => 'changed query' };
        popup._listBox = { destroy_all_children() { throw failure; } };
        popup._grab = { release };
        popup._backdrop = { hide() {}, get_parent: () => null, destroy };
        popup._view = new Completions();
        popup._visible = true;
        const oldButton = { add_style_class_name() {}, remove_style_class_name() {} };
        popup._rows = [{ rec: { id: 'old' }, button: oldButton }];
        popup._onNumberPickDigit('1');
        popup._rebuild();
        assert.ok(errors.mock.calls.some(call => call.arguments[1] === failure));
        assert.equal(release.mock.callCount(), 1);
        assert.equal(destroy.mock.callCount(), 1);
        assert.equal(popup.visible, false);
        assert.equal(popup._rows.length, 0);
        assert.equal(popup._onKey({ get_key_symbol: () => Clutter.KEY_Return }), Clutter.EVENT_STOP);
        timers[0]();
        assert.equal(activate.mock.callCount(), 0);
        const click = { get_button: () => Clutter.BUTTON_PRIMARY };
        assert.equal(popup._onRowPress(0, oldButton, click), Clutter.EVENT_STOP);
        popup._view = new Completions();
        const freshButton = { add_style_class_name() {}, remove_style_class_name() {} };
        popup._rows = [{ rec: { id: 'fresh' }, button: freshButton }];
        popup._onRowPress(0, oldButton, click);
        assert.equal(activate.mock.callCount(), 0, 'retired button cannot use the new row at its index');
        popup._onRowPress(0, freshButton, click);
        assert.deepEqual(activate.mock.calls.map(call => call.arguments[0].id), ['fresh']);
    });

    test(`GNOME ${version} retires the indicator clear timeout before actor destruction`, async t => {
        const { Indicator } = await import(`../copy-gnome-${version}/ui/indicator.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        const timers = holdTimers(t);
        const indicator = new Indicator();
        indicator._work = new Completions();
        indicator._clearItem = { label: { text: 'Clear history' } };
        indicator._onClearMenu();
        assert.equal(indicator._clearArmed, true);
        timers[0]();
        assert.equal(indicator._clearItem.label.text, 'Clear history');
        indicator._onClearMenu();
        indicator.retire();
        indicator.retire();
        const disarm = t.mock.method(indicator, '_disarmClear');
        timers[1]();
        assert.equal(disarm.mock.callCount(), 0, 'a retained native source must not call the retired indicator');
        assert.equal(indicator._clearArmed, false);
    });

    test(`GNOME ${version} stops a key event when reading its symbol or modifiers fails`, async t => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        const { log } = await import(`../copy-gnome-${version}/core/log.js`);
        const errors = t.mock.method(log, 'error', () => {});
        const save = t.mock.fn();
        const popup = new Popup({ onSave: save });
        popup._entry = {};
        popup._view = new Completions();
        popup._isSearchFocused = () => true;
        try {
            for (const field of ['get_key_symbol', 'get_state']) {
                const event = { get_key_symbol: () => Clutter.KEY_s, get_state: () => 0 };
                const failure = new Error(`injected ${field} failure`);
                event[field] = () => { throw failure; };
                assert.equal(popup._onKey(event), Clutter.EVENT_STOP);
                assert.deepEqual(errors.mock.calls.at(-1).arguments, ['[popup]: key-press-event', failure]);
            }
            assert.equal(save.mock.callCount(), 0);
            assert.equal(errors.mock.callCount(), 2);
            assert.equal(popup._onKey({ get_key_symbol: () => 97, get_state: () => 0 }), Clutter.EVENT_PROPAGATE);
        } finally {
            popup.hide();
        }
    });

    test(`GNOME ${version} key read failure retires a pending number pick even if timer removal fails`, async t => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        const { log } = await import(`../copy-gnome-${version}/core/log.js`);
        const errors = t.mock.method(log, 'error', () => {});
        const timers = holdTimers(t);
        const save = t.mock.fn();
        const popup = new Popup({ onSave: save });
        const activated = [];
        popup._activate = record => activated.push(record.id);
        popup._entry = {};
        popup._view = new Completions();
        popup._rows = ['A', 'B'].map(id => ({
            rec: { id }, button: { add_style_class_name() {}, remove_style_class_name() {} },
        }));
        try {
            popup._onNumberPickDigit('2');
            const fault = new Error('injected modifier read failure');
            assert.equal(popup._onKey({
                get_key_symbol: () => Clutter.KEY_s,
                get_state() { throw fault; },
            }), Clutter.EVENT_STOP);
            assert.equal(popup._numberPickRecordId, null);
            assert.equal(popup._numberPickBuffer, '');
            assert.equal(save.mock.callCount(), 0);
            assert.ok(errors.mock.calls.some(call => call.arguments[1] === fault));
            assert.ok(errors.mock.calls.some(call => call.arguments[1]?.message === 'injected source removal failure'));

            popup._onNumberPickDigit('1');
            timers[0]();
            assert.deepEqual(activated, [], 'the old timeout must not activate either record');
            timers[1]();
            assert.deepEqual(activated, ['A']);
        } finally {
            popup.hide();
        }
    });

    test(`GNOME ${version} closes the popup even if timer cleanup fails`, async () => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const popup = new Popup({});
        const steps = [];
        let hints = 0;
        popup._visible = true;
        popup._view = { close() { steps.push('retire'); } };
        popup._grab = { release() { steps.push('release'); } };
        popup._backdrop = { hide() {}, get_parent: () => null, destroy() { steps.push('destroy'); } };
        popup._showNumberHint = () => { hints++; throw new Error('disposed hint'); };
        popup._clearSaveHint = () => { throw new Error('injected save hint cleanup failure'); };
        popup.hide();
        popup.hide();
        assert.deepEqual(steps, ['retire', 'release', 'destroy']);
        assert.equal(hints, 0);
        assert.equal(popup.visible, false);
        assert.equal(popup._grab, null);
        assert.equal(popup._backdrop, null);
    });

    test(`GNOME ${version} removes a failed backdrop from hit testing`, async () => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const popup = new Popup({});
        let detached = false;
        let released = false;
        const backdrop = {
            reactive: true, visible: true,
            hide() { this.visible = false; },
            destroy() { throw new Error('injected destroy failure'); },
            get_parent: () => ({ remove_child(actor) { detached = actor === backdrop; } }),
        };
        popup._grab = { release() { released = true; } };
        popup._backdrop = backdrop;
        popup.hide();
        popup.hide();
        assert.ok(released && detached);
        assert.ok(!backdrop.reactive && !backdrop.visible);
    });

    test(`GNOME ${version} commits the previewed record across list changes`, async t => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        const timers = holdTimers(t);
        const popup = new Popup({});
        const row = id => ({ rec: { id }, button: { add_style_class_name() {}, remove_style_class_name() {} } });
        const a = row('A'), b = row('B');
        const activated = [];
        popup._activate = rec => activated.push(rec.id);
        popup._view = new Completions();
        popup._rows = [a];
        popup._onNumberPickDigit('1');
        popup._rows = [b, a];
        timers[0]();
        assert.deepEqual(activated, ['A']);
        popup._onNumberPickDigit('2');
        popup._rows = [b, row('replacement')];
        timers[1]();
        assert.deepEqual(activated, ['A'], 'a removed record must not activate its replacement');
        popup._onNumberPickDigit('1');
        popup._rows.reverse();
        popup._commitNumberPick(); // Enter while the timeout is still pending.
        timers[2]();
        assert.deepEqual(activated, ['A', 'B']);
        popup.hide();
    });

    test(`GNOME ${version} keeps hint and clear timers local to their view`, async t => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        const timers = holdTimers(t);
        let clears = 0;
        const popup = new Popup({ onClear: () => clears++ });
        t.mock.method(popup, '_rebuild', () => true);
        attachHint(popup);
        popup._view = new Completions();
        popup._showSaveHint('old');
        popup._onClearClicked();
        popup.hide();
        popup._view = new Completions();
        const hint = attachHint(popup);
        popup._showSaveHint('new');
        popup._onClearClicked();
        timers[0]();
        timers[1]();
        assert.equal(hint.text, 'new');
        assert.equal(popup._clearArmed, true);
        timers[2]();
        timers[3]();
        assert.equal(hint.text, '');
        assert.equal(popup._clearArmed, false);
        assert.equal(clears, 0);
        popup._onClearClicked();
        popup._onClearClicked();
        assert.equal(clears, 1, 'an intentional second click still clears exactly once');
        GLib.timeout_add = () => { throw new Error('injected confirmation setup failure'); };
        popup._onClearClicked();
        popup._onClearClicked();
        assert.equal(popup._clearArmed, false);
        assert.equal(clears, 1, 'a failed deadline cannot leave the clear button armed');
        popup.hide();
    });

    test(`GNOME ${version} save timeout preserves a newer number hint in the same view`, async t => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        const timers = holdTimers(t);
        const popup = new Popup({});
        const hint = attachHint(popup);
        popup._view = new Completions();
        popup._rows = [{ rec: { id: 'A' }, button: { add_style_class_name() {}, remove_style_class_name() {} } }];
        let activated;
        popup._activate = record => { activated = record.id; };
        popup._showSaveHint('History saved');
        assert.equal(hint.text, 'History saved');
        popup._onNumberPickDigit('1');
        const preview = hint.text;
        assert.match(preview, /Row 1 selected/);
        timers[0]();
        assert.equal(hint.text, preview);
        timers[1]();
        assert.equal(activated, 'A');
        popup.hide();
    });

    test(`GNOME ${version} Ctrl+S saves when the pre-save hint update throws`, async t => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        const { log } = await import(`../copy-gnome-${version}/core/log.js`);
        const errors = t.mock.method(log, 'error', () => {});
        const timers = holdTimers(t);
        const previousIdle = GLib.idle_add;
        GLib.idle_add = (_priority, callback) => setImmediate(callback);
        t.after(() => { GLib.idle_add = previousIdle; });
        let saves = 0, activations = 0;
        const popup = new Popup({ onSave: () => { saves++; return Promise.resolve('saved'); } });
        const hint = attachHint(popup);
        popup._entry = {};
        popup._view = new Completions();
        popup._isCtrlF = () => false;
        popup._isCtrlS = () => true;
        popup._isSearchFocused = () => false;
        popup._rows = [{ rec: { id: 'A' }, button: { add_style_class_name() {}, remove_style_class_name() {} } }];
        popup._activate = () => activations++;
        popup._onNumberPickDigit('1');
        const failure = new Error('injected hint update failure');
        t.mock.method(hint, 'set_text', () => { throw failure; }, { times: 1 });

        assert.doesNotThrow(() => popup._onKey({ get_key_symbol: () => 's' }));
        assert.equal(saves, 1);
        assert.equal(popup._numberPickBuffer, '');
        assert.equal(popup._numberPickRecordId, null);
        timers[0]();
        assert.equal(activations, 0, 'the cancelled number pick must not fire after saving');
        assert.ok(errors.mock.calls.some(({ arguments: [stage, error] }) =>
            stage.includes('pre-save hint') && error === failure));
        await Promise.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(hint.text, 'History saved');
        popup.hide();
    });

    test(`GNOME ${version} late save completions preserve newer hints`, async t => {
        const { Popup } = await import(`../copy-gnome-${version}/ui/popup.js`);
        const { Completions } = await import(`../copy-gnome-${version}/core/completions.js`);
        holdTimers(t);
        const previousIdle = GLib.idle_add;
        GLib.idle_add = (_priority, callback) => setImmediate(callback);
        t.after(() => { GLib.idle_add = previousIdle; });
        const requests = [];
        const popup = new Popup({ onSave: () => new Promise(resolve => requests.push(resolve)) });
        const hint = attachHint(popup);
        popup._view = new Completions();
        popup._entry = {};
        popup._isSearchFocused = () => false;
        popup._isCtrlF = () => false;
        popup._isCtrlS = () => true;
        popup._rows = [{ rec: { id: 'A' }, button: { add_style_class_name() {}, remove_style_class_name() {} } }];
        const save = () => popup._onKey({ get_key_symbol: () => 's' });
        async function complete(request, status) {
            request(status);
            await Promise.resolve();
            await new Promise(resolve => setImmediate(resolve));
        }

        save();
        popup._onNumberPickDigit('1');
        await complete(requests[0], 'saved');
        assert.match(hint.text, /Row 1 selected/, 'the pending save cannot replace the number preview');
        save();
        save();
        await complete(requests[2], 'busy');
        assert.equal(hint.text, 'Save already in progress');
        await complete(requests[1], 'saved');
        assert.equal(hint.text, 'Save already in progress', 'an older completion cannot replace the later response');
        save();
        await complete(requests[3], 'failed');
        assert.equal(hint.text, 'History save failed', 'the current save must still show its result');
        popup.hide();
    });
}
