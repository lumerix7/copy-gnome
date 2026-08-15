// Load Shell typelibs, then substitute a local St.Clipboard fixture.
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import { ClipboardReadScope, getContentResult, getText } from '../copy-gnome-50/core/clipboard.js';
import { Monitor } from '../copy-gnome-50/core/monitor.js';
import { schedulePaste } from '../copy-gnome-50/core/paste.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function tick() {
    return new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function startMonitor(monitor) {
    const previous = globalThis.global;
    let notify;
    const selection = {
        connect(_name, callback) { notify = callback; return 1; },
        disconnect() {},
    };
    globalThis.global = { display: { get_selection: () => selection } };
    try {
        monitor.start();
        assert(monitor.clipboardState.active, 'monitor must subscribe');
    } finally {
        if (previous === undefined)
            delete globalThis.global;
        else
            globalThis.global = previous;
    }
    return source => notify(selection, Meta.SelectionType.SELECTION_CLIPBOARD, source);
}

const originalGetDefault = St.Clipboard.get_default;
let reads = 0;
let buffer = new Uint8Array([1, 2, 3, 4]);
St.Clipboard.get_default = () => ({
    get_text(_selection, callback) {
        reads++;
        callback(null, 'fixture');
    },
    get_content(_selection, _mime, callback) {
        reads++;
        callback(null, {
            get_size: () => buffer.length,
            get_data: () => buffer,
        });
    },
});

try {
    assert(await getText() === 'fixture' && reads === 1, 'plain text uses one wrapper read');
    const result = await getContentResult('text/plain', 4);
    assert(result.ok && reads === 2, 'content uses one wrapper read');
    buffer[0] = 99;
    assert(result.bytes[0] === 1, 'clipboard result must be detached from the source buffer');

    buffer = new Uint8Array(5);
    const large = await getContentResult('text/plain', 4);
    assert(!large.ok && large.reason === 'oversize' && reads === 3,
        'over-limit clipboard input must be dropped without a retry');

    const captures = [];
    const monitor = new Monitor({
        maxTextBytes: () => 16,
        secretMimes: () => ['application/x-concealed'],
        onCapture: item => captures.push(item),
    });
    const change = startMonitor(monitor);
    const mimes = ['text/html', 'text/plain;charset=utf-8'];
    buffer = new TextEncoder().encode('<b>fixture</b>');
    change({ get_mimetypes: () => mimes });
    await tick();
    assert(captures.length === 1 && captures[0].kind === 'text' &&
        captures[0].text === 'fixture' && reads === 5,
    'rich fallback must reuse the single successful plain-text read');

    change({ get_mimetypes: () => [...mimes, 'application/x-concealed'] });
    await tick();
    assert(captures.length === 1 && reads === 5, 'concealed data must be skipped before reading');
    monitor.stop();

    const timeoutAdd = GLib.timeout_add;
    const callbacks = [];
    let copies = 0;
    GLib.timeout_add = (priority, _interval, callback) => timeoutAdd(priority, 5, callback);
    St.Clipboard.get_default = () => ({
        get_content(_selection, _mime, callback) { callbacks.push(callback); },
    });
    try {
        const first = getContentResult('text/plain', 4);
        const second = getContentResult('text/plain', 4);
        assert((await first).reason === 'timeout' && (await second).reason === 'timeout',
            'held native reads must time out at the caller');
        assert((await getContentResult('text/plain', 4)).reason === 'busy' && callbacks.length === 2,
            'caller timeouts must not free native slots');
        const lateBytes = {
            get_size() { copies++; return 1; },
            get_data() { copies++; return new Uint8Array([9]); },
        };
        callbacks[0](null, lateBytes);
        assert(copies === 0, 'late completion must be discarded before inspecting bytes');
        const fresh = getContentResult('text/plain', 4);
        callbacks[2](null, lateBytes);
        assert((await fresh).bytes[0] === 9, 'native completion must release its slot');
        callbacks[1](null, lateBytes);

        const scope = new ClipboardReadScope();
        const retired = getContentResult('text/plain', 4, scope);
        scope.close();
        assert((await retired).reason === 'cancelled', 'stop must retire a pending read');
        const before = copies;
        callbacks[3](null, lateBytes);
        assert(copies === before, 'retired completion must not inspect native bytes');
    } finally {
        GLib.timeout_add = timeoutAdd;
    }
    print('St.Clipboard wrapper tests passed');
} finally {
    St.Clipboard.get_default = originalGetDefault;
}

async function testDelayedPasteFocus() {
    const timers = new Set();
    const clipboard = { active: true, version: 1, recordId: 'fixture' };
    const injections = [];
    const target = { get_stable_sequence: () => 42 };
    const other = { get_stable_sequence: () => 43 };
    let focused = other;
    let actors = [{ meta_window: target }];
    let activations = 0;
    globalThis.global = {
        display: { get_focus_window: () => focused },
        get_window_actors: () => actors,
        get_current_time: () => 1,
    };
    const shortcut = ['ctrl', 'v'];
    const schedule = (restoreFocus = true) => schedulePaste(timers, clipboard, {
        windowId: 42, recordId: 'fixture', keys: shortcut, delayMs: 0, restoreFocus,
    }, keys => {
        injections.push(keys);
        return true;
    });
    const tick = () => new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
    try {
        target.activate = () => { activations++; };
        clipboard.recordId = null;
        schedule();
        assert(timers.size === 0, 'an unconfirmed clipboard must not schedule a paste');
        clipboard.recordId = 'fixture';
        schedule();
        actors = [];
        await tick();
        assert(!activations && !injections.length, 'a closed target must not activate or paste into another window');

        actors = [{ meta_window: target }];
        target.activate = () => { throw new Error('fixture focus failure'); };
        schedule();
        await tick();
        assert(!injections.length, 'failed activation must prevent injection');

        target.activate = () => { activations++; };
        schedule();
        await tick();
        assert(activations === 1 && !injections.length, 'unchanged focus must prevent injection');

        schedule(false);
        await tick();
        assert(activations === 1 && !injections.length, 'disabled focus restore must still check focus');

        target.activate = () => {
            focused = target;
            timers.clear();
        };
        schedule();
        await tick();
        assert(!injections.length, 'retirement during focus activation must prevent injection');

        focused = other;
        target.activate = () => { activations++; };
        schedule();
        clipboard.version++;
        clipboard.recordId = 'replacement';
        await tick();
        assert(activations === 1 && !injections.length, 'replaced clipboard must cancel paste before moving focus');

        clipboard.recordId = 'fixture';
        target.activate = () => {
            focused = target;
            clipboard.version++;
            clipboard.recordId = null;
        };
        schedule();
        await tick();
        assert(!injections.length, 'clipboard replacement during activation must prevent injection');

        focused = other;
        clipboard.recordId = 'fixture';
        target.activate = () => { focused = target; };
        schedule();
        shortcut[1] = 'x';
        await tick();
        assert(injections.length === 1 && injections[0].join('+') === 'ctrl+v' && !timers.size,
            'confirmed focus must inject only the captured shortcut once');
        print('delayed paste focus tests passed');
    } finally {
        delete globalThis.global;
    }
}

await testDelayedPasteFocus();

async function testRepeatedCut() {
    const mime = 'x-special/gnome-copied-files';
    const source = { get_mimetypes: () => [mime] };
    const bytes = new GLib.Bytes(new TextEncoder().encode('cut\nfile:///fixture'));
    const captures = [];
    let top;
    let reads = 0;
    let held = false;
    let deliver;
    let repeats = 0;
    const monitor = new Monitor({
        captureFiles: () => true,
        onCapture: record => { captures.push(record); top = record; },
        onSuppressedRepeat: repeat => {
            repeats++;
            return top?.text === repeat.value ? top.id : null;
        },
    });
    const clipboard = monitor.clipboardState;
    const change = startMonitor(monitor);
    St.Clipboard.get_default = () => ({
        get_content(_selection, _mime, callback) {
            reads++;
            if (held)
                deliver = () => callback(null, bytes);
            else
                callback(null, bytes);
        },
    });
    try {
        change(source);
        await tick();
        change(source);
        await tick();
        assert(captures.length === 1 && reads === 2 && clipboard.recordId === top.id,
            'the second cut must confirm the original row for reuse after exactly one read per event');
        monitor.setLastContent({ origin: 'restore', sourceKind: 'memory', type: 'file', value: top.text });
        const self = { ...source, toString: () => 'Meta.SelectionSourceMemory' };
        change(self);
        await tick();
        assert(repeats === 1 && clipboard.recordId === null, 'the file write-back echo must stay filtered');
        change({ ...source, toString() { throw new Error('unknown source'); } });
        await tick();
        assert(repeats === 1 && clipboard.recordId === null, 'an unknown source must not confirm the restored file');
        for (let i = 0; i < 2; i++) {
            change(source);
            await tick();
            assert(clipboard.recordId === top.id, 'a fresh external cut must be confirmed even after a restore');
        }
        assert(repeats === 3 && captures.length === 1 && reads === 6, 'each cut must reuse the visible row after one read');
        held = true;
        change(source);
        await tick();
        change(null);
        deliver();
        await tick();
        assert(clipboard.recordId === null, 'a late repeat cannot rebind the cleared clipboard');
        top = null;
        held = false;
        change(source);
        await tick();
        assert(clipboard.recordId === null, 'a repeat without a matching history head cannot confirm reuse');
    } finally {
        monitor.stop();
        St.Clipboard.get_default = originalGetDefault;
    }
}

await testRepeatedCut();

async function testCaptureQueue() {
    const records = [];
    let allowFiles = true;
    let limit = 256;
    let policyReads = 0, reads = 0, turns = 0;
    let first;
    const monitor = new Monitor({
        captureFiles: () => { policyReads++; return allowFiles; },
        maxItemBytes: () => limit,
        onCapture: record => records.push(record),
    });
    const mimes = ['text/uri-list'];
    const source = { get_mimetypes: () => mimes };
    const change = startMonitor(monitor);
    St.Clipboard.get_default = () => ({
        get_content(_selection, _mime, callback) {
            reads++;
            assert(turns === reads - 1, 'each native read must give the main loop a turn before the next');
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { turns++; return GLib.SOURCE_REMOVE; });
            const bytes = new GLib.Bytes(new TextEncoder().encode(`file:///fixture/${reads}`));
            if (reads === 1)
                first = () => callback(null, bytes);
            else
                callback(null, bytes);
        },
    });
    try {
        change(source);
        await tick();
        for (let i = 0; i < 1024; i++)
            change(source);
        assert(reads === 1 && monitor._queue.length === 32, 'only 32 jobs may wait behind an outstanding read');
        allowFiles = false;
        limit = 1;
        mimes[0] = 'application/unrelated';
        first();
        await tick();
        assert(records.length === 33 && reads === 33 && turns === 33 && policyReads === 1025,
            'queued jobs must use their own MIME and policy snapshots with no additional getter calls');
        assert(records[0].seq === 1 && records.slice(1).every((rec, i) => rec.seq === 994 + i),
            'overflow must retain the newest pending entries in FIFO order');
    } finally {
        monitor.stop();
        St.Clipboard.get_default = originalGetDefault;
    }
}

async function testCaptureRetirement() {
    const privateMime = 'application/x-private-fixture';
    const records = [], callbacks = [];
    const monitor = new Monitor({ onCapture: rec => records.push(rec), secretMimes: () => [privateMime] });
    const change = startMonitor(monitor);
    const source = { get_mimetypes: () => ['text/html', 'text/plain'] };
    let byteAccesses = 0;
    const late = { get_size() { byteAccesses++; return 1; }, get_data() { byteAccesses++; return new Uint8Array([1]); } };
    St.Clipboard.get_default = () => ({
        get_content(_selection, _mime, callback) { callbacks.push(callback); },
        get_text(_selection, callback) { callback(null, 'fresh text'); },
    });
    try {
        change(source);
        await tick();
        change(source);
        change({ get_mimetypes: () => ['text/plain', privateMime] });
        callbacks[0](null, late);
        await tick();
        assert(callbacks.length === 1 && !records.length && !byteAccesses, 'concealed owner must retire queued reads and late bytes');
        change({ get_mimetypes: () => Array(256).fill('text/plain').concat(privateMime) });
        await tick();
        assert(!records.length, 'oversized MIME metadata must not truncate away a privacy marker');
        change(source);
        await tick();
        monitor.stop();
        const next = startMonitor(monitor);
        change(source); // A signal already queued for the retired subscription.
        callbacks[1](null, late);
        next({ get_mimetypes: () => ['text/plain'] });
        await tick();
        assert(callbacks.length === 2 && !byteAccesses && records.length === 1 && records[0].text === 'fresh text',
            'only the fresh generation may read and deliver after restart');
    } finally {
        monitor.stop();
        St.Clipboard.get_default = originalGetDefault;
    }
}

await testCaptureQueue();
await testCaptureRetirement();
print('bounded capture queue, detached policy and retirement tests passed');

async function testCaptureFormats() {
    const captures = [], calls = [];
    const monitor = new Monitor({ captureFiles: () => true, captureImages: () => true, onCapture: rec => captures.push(rec) });
    const change = startMonitor(monitor);
    const values = new Map([
        ['text/html', '<b>hello</b>'], ['text/rtf', '{\\rtf1 hello}'],
        ['text/uri-list', 'file:///fixture'], ['image/png', new Uint8Array([3, 4, 5])],
    ]);
    St.Clipboard.get_default = () => ({
        get_text(_sel, cb) { calls.push('text'); cb(null, 'hello'); },
        get_content(_sel, mime, cb) {
            calls.push(mime);
            const value = values.get(mime);
            cb(null, value ? new GLib.Bytes(typeof value === 'string' ? new TextEncoder().encode(value) : value) : null);
        },
    });
    try {
        change({ get_mimetypes: () => ['text/html', 'text/plain', 'text/rtf'] });
        await tick();
        assert(captures[0]?.kind === 'rich' && captures[0].text === 'hello' &&
            captures[0].rich === values.get('text/html') && captures[0].companionPayloads[0]?.value === values.get('text/rtf') &&
            calls.join() === 'text/html,text,text/rtf', 'rich and companion representations must each be read once');
        calls.length = 0;
        change({ get_mimetypes: () => ['x-special/gnome-copied-files', 'text/uri-list'] });
        await tick();
        assert(captures[1]?.text === 'file:///fixture' && calls.join() === 'x-special/gnome-copied-files,text/uri-list',
            'a failed file offer may fall back once to uri-list');
        change({ get_mimetypes: () => ['image/png'] });
        await tick();
        values.get('image/png')[0] = 7;
        assert(captures[2]?.kind === 'image' && captures[2].bytes[0] === 3, 'image data must stay detached');
    } finally {
        monitor.stop();
        St.Clipboard.get_default = originalGetDefault;
    }
}

await testCaptureFormats();

const monitor = new Monitor();
startMonitor(monitor);
const stamp = monitor.clipboardState;
monitor.setLastContent({ id: 'current', origin: 'capture', type: 'text', value: 'fixture', clipboardVersion: 0 });
assert(stamp.recordId === 'current', 'a capture at the current generation can confirm recent-top reuse');
monitor._onOwnerChanged(Meta.SelectionType.SELECTION_PRIMARY, null);
assert(stamp.version === 0, 'primary selection must not invalidate clipboard');
monitor._onOwnerChanged(Meta.SelectionType.SELECTION_CLIPBOARD, null);
assert(stamp.version === 1 && stamp.recordId === null, 'a clear must invalidate pending clipboard confirmations');
monitor.setLastContent({ id: 'late', origin: 'capture', type: 'text', value: 'fixture', clipboardVersion: 0 });
assert(stamp.recordId === null, 'a late capture cannot confirm the new generation');
const beforeWrite = monitor.beginClipboardWrite();
monitor.confirmClipboardWrite(beforeWrite, 'unconfirmed');
assert(stamp.recordId === null, 'a write without a new owner signal must stay unconfirmed');
monitor._onOwnerChanged(Meta.SelectionType.SELECTION_CLIPBOARD, null);
monitor.confirmClipboardWrite(beforeWrite, 'cleared');
assert(stamp.recordId === null, 'a clipboard clear is not a confirmed write');
const beforeOwnedWrite = monitor.beginClipboardWrite();
monitor._queueRead = () => {};
monitor._onOwnerChanged(Meta.SelectionType.SELECTION_CLIPBOARD, {});
monitor.confirmClipboardWrite(beforeOwnedWrite, 'written');
assert(stamp.recordId === 'written', 'a single owner change during the write confirms the record');
monitor._onOwnerChanged(Meta.SelectionType.SELECTION_CLIPBOARD, {});
monitor.confirmClipboardWrite(beforeOwnedWrite, 'late-write');
assert(stamp.recordId === null, 'multiple owner changes make the write ambiguous');
monitor.stop();
assert(!stamp.active, 'retired monitor state must disable scheduled paste');
