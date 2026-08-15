import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { DBusTransport, IPC_BUS_NAME, IPC_OBJECT_PATH } from '../copy-gnome-50/core/ipc.js';
import { saveFileDialog } from '../copy-gnome-50/core/save.js';
import { log } from '../copy-gnome-50/core/log.js';

if (GLib.getenv('COPY_GNOME_PRIVATE_TEST_BUS') !== '1')
    throw new Error('run on a private D-Bus session');

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

Gio._promisify(Gio, 'bus_get', 'bus_get_finish');
Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
const bus = await Gio.bus_get(Gio.BusType.SESSION, null);
const wait = () => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function hasOwner() {
    const reply = await bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', [IPC_BUS_NAME]),
        new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, 200, null);
    return reply.deepUnpack()[0];
}

async function waitForOwner(present) {
    const deadline = GLib.get_monotonic_time() + 2500000;
    while (GLib.get_monotonic_time() < deadline) {
        if (await hasOwner() === present)
            return;
        await wait();
    }
    throw new Error(`IPC owner state did not become ${present}`);
}

async function call(method) {
    const reply = await bus.call(IPC_BUS_NAME, IPC_OBJECT_PATH, IPC_BUS_NAME, method, null,
        new GLib.VariantType('(s)'), Gio.DBusCallFlags.NO_AUTO_START, 1000, null);
    return JSON.parse(reply.deepUnpack()[0]);
}

const transport = new DBusTransport();
try {
    let enter;
    let finish;
    let hold = false;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { finish = resolve; });
    transport.start({
        Status: () => ({ ok: true, ready: true }),
        Popup: () => {
            throw { get message() { throw new Error('inject getter failure'); } };
        },
        GetClipboardText: async () => {
            if (!hold)
                throw new Error('injected rejection');
            enter();
            return held;
        },
    });
    await waitForOwner(true);
    assert((await call('Status')).ready, 'service must reply to Status');
    const thrown = await call('Popup');
    assert(thrown.code === 'internal-error' && thrown.error === 'unknown error',
        'throwing error getter must still produce a JSON reply');
    const rejected = await call('GetClipboardText');
    assert(rejected.code === 'internal-error' && rejected.error === 'injected rejection',
        'rejected handler must still produce a JSON reply');
    hold = true;
    const retired = call('GetClipboardText');
    await entered;
    transport.stop();
    transport.stop();
    assert((await retired).code === 'not-ready', 'stop must retire an already pending request');
    finish({ ok: true, text: 'retired synthetic result' });
    await wait();
    await waitForOwner(false);
    print('private D-Bus lifecycle tests passed');
} finally {
    transport.stop();
}

async function testRetiredSaveDialog(cancelBeforeAcknowledgement) {
    const name = 'org.freedesktop.portal.Desktop';
    const chooser = 'org.freedesktop.portal.FileChooser';
    const requestInterface = 'org.freedesktop.portal.Request';
    const acquired = await bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'RequestName', new GLib.Variant('(su)', [name, 4]),
        null, Gio.DBusCallFlags.NONE, 1000, null);
    assert(acquired.deepUnpack()[0] === 1, 'private portal name unavailable');
    let arrived;
    let close;
    let requestObject;
    let handle;
    let acknowledge;
    let closeCount = 0;
    const received = new Promise(resolve => { arrived = resolve; });
    const closed = new Promise(resolve => { close = resolve; });
    const portal = Gio.DBusExportedObject.wrapJSObject(`<node><interface name="${chooser}">
        <method name="SaveFile"><arg type="s" direction="in"/><arg type="s" direction="in"/>
        <arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
        </interface></node>`, {
        SaveFileAsync([_parent, _title, options], invocation) {
            const sender = invocation.get_sender().slice(1).replaceAll('.', '_');
            const token = options.handle_token.deepUnpack();
            handle = `/org/freedesktop/portal/desktop/request/${sender}/${cancelBeforeAcknowledgement ? `actual_${token}` : token}`;
            requestObject = Gio.DBusExportedObject.wrapJSObject(
                `<node><interface name="${requestInterface}"><method name="Close"/></interface></node>`,
                { Close() { closeCount++; close(); } });
            acknowledge = () => {
                requestObject.export(bus, handle);
                invocation.return_value(new GLib.Variant('(o)', [handle]));
            };
            if (!cancelBeforeAcknowledgement)
                acknowledge();
            arrived();
        },
    });
    portal.export(bus, '/org/freedesktop/portal/desktop');
    try {
        const cancellable = new Gio.Cancellable();
        const dialog = saveFileDialog({ currentFolder: null, cancellable });
        await received;
        if (!cancelBeforeAcknowledgement)
            await wait();
        cancellable.cancel();
        assert(await dialog === null, 'the caller must finish before a delayed acknowledgement');
        if (cancelBeforeAcknowledgement)
            acknowledge();
        await closed;
        bus.emit_signal(null, handle, requestInterface, 'Response',
            new GLib.Variant('(ua{sv})', [0, { uris: new GLib.Variant('as', ['file:///isolated']) }]));
        await wait();
        assert(closeCount === 1, 'the actual request handle must be closed exactly once');
        print(`private save dialog cancellation test passed (early=${cancelBeforeAcknowledgement})`);
    } finally {
        requestObject?.unexport();
        portal.unexport();
        await bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ReleaseName',
            new GLib.Variant('(s)', [name]), null, Gio.DBusCallFlags.NONE, 1000, null);
    }
}

await testRetiredSaveDialog(false);
await testRetiredSaveDialog(true);

async function testSaveDirectoryDeadline() {
    const original = Gio.File.prototype.query_info_async;
    const warn = log.warn;
    const warnings = [];
    const parent = new Gio.Cancellable();
    let child, deliver;
    try {
        log.warn = (...args) => { warnings.push(args[0]); warn(...args); };
        Gio.File.prototype.query_info_async = function (...args) {
            child = args[3];
            // Once the directory deadline fires, retire the caller before any portal dialog.
            child.connect(() => parent.cancel());
            const callback = args.pop();
            deliver = () => new Promise(resolve => original.call(this, ...args, (file, result) => {
                callback(file, result);
                resolve();
            }));
        };
        const uri = await saveFileDialog({ currentFolder: GLib.get_tmp_dir(), cancellable: parent });
        assert(uri === null && child.is_cancelled(), 'directory timeout must cancel the native request');
        await deliver();
        assert(warnings.filter(line => line.includes('directory') && line.includes('timed out')).length === 1,
            'the actual directory timeout must produce exactly one WARN, including after the late reply');
        print('private save directory deadline test passed');
    } finally {
        Gio.File.prototype.query_info_async = original;
        log.warn = warn;
    }
}

await testSaveDirectoryDeadline();
