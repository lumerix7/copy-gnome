import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { readConfigSnapshot } from '../copy-gnome-50/core/config-reader.js';
import { getSessionBus } from '../copy-gnome-50/core/session-bus.js';
import { uriExists } from '../copy-gnome-50/core/reveal.js';
import { log } from '../copy-gnome-50/core/log.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function connectionProbe() {
    let ticks = 0;
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
        ticks++;
        return GLib.SOURCE_CONTINUE;
    });
    try {
        const result = getSessionBus(75);
        assert(result === getSessionBus(), 'pending connections must be coalesced');
        assert(await result === null, 'stalled bus authentication must time out');
        assert(ticks > 1, 'connection attempt must leave the event loop responsive');
    } finally {
        GLib.Source.remove(timer);
    }
}

async function testRevealCancellation(path) {
    const original = Gio.File.prototype.query_info_async;
    const queries = [];
    const parent = new Gio.Cancellable();
    const disconnect = parent.disconnect;
    let cancelling = false;
    let disconnects = 0;
    const warnings = [];
    const warn = log.warn;
    const uri = Gio.File.new_for_path(path).get_uri();
    Gio.File.prototype.query_info_async = function (...args) {
        const callback = args.pop();
        const finish = () => new Promise(resolve => {
            original.call(this, ...args, (file, res) => {
                callback(file, res);
                resolve();
            });
        });
        queries.push({ child: args[3], finish });
    };
    parent.disconnect = function (id) {
        assert(!cancelling, 'must not disconnect from inside parent cancellation');
        disconnect.call(this, id);
        disconnects++;
    };
    log.warn = (...args) => { warnings.push(args[0]); warn(...args); };
    try {
        const timeout = uriExists(uri, 15, parent);
        let siblingFinished = false;
        const sibling = uriExists(uri, 1500, parent).then(exists => {
            siblingFinished = true;
            return exists;
        });
        assert(await timeout, 'uncertain existence still allows the file manager to decide');
        assert(queries[0].child.is_cancelled() && !queries[1].child.is_cancelled() && !parent.is_cancelled(),
            'a deadline must cancel only its own native query');
        assert(warnings.some(message => message.includes('timed out')), 'query timeout must log at WARN');
        cancelling = true;
        try {
            parent.cancel();
        } finally {
            cancelling = false;
        }
        assert(queries[1].child.is_cancelled(), 'parent cancellation must reach the other child');
        await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        assert(siblingFinished, 'parent cancellation must settle without a native reply or a deadline expiry');
        assert(warnings.length === 1, 'explicit cancellation must not add a timeout warning');
        assert(disconnects === 2, 'both queries must have detached before the late replies');
        await Promise.all(queries.map(query => query.finish()));
        assert(await sibling, 'parent cancellation must settle the outstanding query');
        assert(warnings.length === 1, 'late replies must not report another timeout');
        assert(await uriExists(uri, 1500, parent) && queries.length === 2, 'already-cancelled parents must not start I/O');
    } finally {
        Gio.File.prototype.query_info_async = original;
        parent.disconnect = disconnect;
        log.warn = warn;
    }
    assert(!await uriExists(uri), 'an actual missing local file must still be reported missing');
}

async function testIo() {
    const dir = GLib.dir_make_tmp('copy-gnome-runtime-io-XXXXXX');
    const config = `${dir}/config.yaml`;
    const json = `${dir}/config.json`;
    const helper = `${dir}/gjs`;
    const socket = `${dir}/test-bus`;
    const path = GLib.getenv('PATH');
    const service = new Gio.SocketService();
    const connections = [];
    try {
        await testRevealCancellation(`${dir}/absent`);
        GLib.file_set_contents(config, 'history:\n  maxItems: 75\n');
        const parsed = await readConfigSnapshot(dir).work;
        assert(parsed?.history.maxItems === 75, 'detached reader must parse a valid config');
        GLib.unlink(config);
        const hiddenMime = 'application/x-test-hidden';
        GLib.file_set_contents(json, JSON.stringify({ privacy: { secretMimes: [hiddenMime] } }));
        const initial = await readConfigSnapshot(dir).work;
        assert(initial?.privacy.secretMimes.includes(hiddenMime), 'valid JSON must preserve custom privacy settings');
        GLib.file_set_contents(json, '{"privacy":');
        assert(await readConfigSnapshot(dir).work === null, 'malformed JSON must signal failure so the caller keeps its cache');
        GLib.unlink(json);
        Gio.Subprocess.new(['/usr/bin/mkfifo', config], Gio.SubprocessFlags.NONE).wait_check(null);
        assert(await readConfigSnapshot(dir).work === null, 'detached reader must refuse a FIFO');

        GLib.file_set_contents(helper, '#!/bin/sh\nexec /usr/bin/sleep 10\n');
        Gio.File.new_for_path(helper).set_attribute_uint32('unix::mode', 0o700, Gio.FileQueryInfoFlags.NONE, null);
        GLib.setenv('PATH', `${dir}:${path}`, true);
        try {
            assert(await readConfigSnapshot(dir, 50).work === null, 'a stalled reader must time out');
            const cancelled = readConfigSnapshot(dir);
            cancelled.cancel();
            assert(await cancelled.work === null, 'retired config work must finish with no data');
        } finally {
            GLib.setenv('PATH', path, true);
        }

        service.add_address(new Gio.UnixSocketAddress({path: socket}), Gio.SocketType.STREAM,
            Gio.SocketProtocol.DEFAULT, null);
        service.connect('incoming', (_service, connection) => {
            connections.push(connection);
            return true;
        });
        service.start();
        Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async', 'wait_check_finish');
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.setenv('DBUS_SESSION_BUS_ADDRESS', `unix:path=${socket}`, true);
        launcher.setenv('GIO_USE_VFS', 'local', true);
        const script = Gio.File.new_for_uri(import.meta.url).get_path();
        const child = launcher.spawnv(['timeout', '4s', 'gjs', '-m', script, '--connection-probe']);
        await child.wait_check_async(null);
        assert(connections.length > 0, 'probe must contact the private socket');
        print('configuration and session D-Bus deadline tests passed');
    } finally {
        service.stop();
        service.close();
        for (const connection of connections)
            connection.close(null);
        GLib.unlink(config);
        GLib.unlink(json);
        GLib.unlink(helper);
        GLib.unlink(socket);
        GLib.rmdir(dir);
    }
}

if (ARGV.includes('--connection-probe'))
    await connectionProbe();
else
    await testIo();
