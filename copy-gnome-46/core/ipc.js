import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { log } from './log.js';

// DBus control channel for the CLI (docs/14-ipc). Extension logic talks to the thin
// IpcTransport surface (start(handlers)/stop()); DBusTransport is the default
// implementation, and a socket transport could replace it without touching the handlers
// or the CLI surface (docs/12-cli).
//
// Fail-closed: transport setup errors are logged and leave the service off; a handler
// error becomes an { ok: false } JSON envelope. Nothing here may throw into the Shell.

export const IPC_BUS_NAME = 'org.gnome.Shell.Extensions.CopyGnome';
export const IPC_OBJECT_PATH = '/org/gnome/Shell/Extensions/CopyGnome';

// Every method returns a single JSON envelope string; docs/14-ipc is the contract.
export const IPC_METHODS = [
    { name: 'List', args: ['u'] },
    { name: 'Get', args: ['s'] },
    { name: 'Use', args: ['s', 's'] },
    { name: 'CopyText', args: ['s'] },
    { name: 'GetClipboardText', args: [] },
    { name: 'Search', args: ['s', 'u'] },
    { name: 'Remove', args: ['s'] },
    { name: 'Clear', args: [] },
    { name: 'Popup', args: [] },
    { name: 'Status', args: [] },
];

function interfaceXml() {
    const methods = IPC_METHODS.map(({ name, args }) => {
        const ins = args
            .map((type, i) => `<arg type="${type}" name="arg${i}" direction="in"/>`)
            .join('');
        return `<method name="${name}">${ins}<arg type="s" name="result" direction="out"/></method>`;
    }).join('');
    return `<node><interface name="${IPC_BUS_NAME}">${methods}</interface></node>`;
}

function errorEnvelope(code, message) {
    return { ok: false, code, error: message };
}

// GJS dispatches DBus calls to `<Method>Async(args, invocation)` when present, which lets
// promise-returning handlers reply without blocking the Shell.
function buildImpl(handlers) {
    const impl = {};
    for (const { name } of IPC_METHODS) {
        impl[`${name}Async`] = (params, invocation) => {
            const finish = envelope => {
                try {
                    invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(envelope)]));
                } catch (e) {
                    log.warn(`[ipc]: ${name} reply failed: ${e.message}`);
                }
            };
            try {
                const handler = handlers[name];
                if (typeof handler !== 'function') {
                    finish(errorEnvelope('not-implemented', `${name} has no handler`));
                    return;
                }
                Promise.resolve(handler(...params))
                    .then(result => {
                        if (result && typeof result === 'object')
                            finish(result);
                        else
                            finish(errorEnvelope('internal-error', `${name} returned no result`));
                    })
                    .catch(e => {
                        log.warn(`[ipc]: ${name} failed: ${e.message}`);
                        finish(errorEnvelope('internal-error', String(e?.message ?? e)));
                    });
            } catch (e) {
                log.warn(`[ipc]: ${name} dispatch failed: ${e.message}`);
                finish(errorEnvelope('internal-error', String(e?.message ?? e)));
            }
        };
    }
    return impl;
}

export class DBusTransport {
    constructor({ name = IPC_BUS_NAME, path = IPC_OBJECT_PATH } = {}) {
        this._name = name;
        this._path = path;
        this._ownerId = 0;
        this._exported = null;
    }

    start(handlers) {
        if (this._ownerId)
            return;
        try {
            const impl = buildImpl(handlers ?? {});
            this._ownerId = Gio.bus_own_name(
                Gio.BusType.SESSION,
                this._name,
                Gio.BusNameOwnerFlags.NONE,
                connection => this._onBusAcquired(connection, impl),
                null,
                () => log.warn(`[ipc]: bus name lost name=${this._name}`));
        } catch (e) {
            log.warn(`[ipc]: start failed: ${e.message}`);
            this._ownerId = 0;
        }
    }

    _onBusAcquired(connection, impl) {
        try {
            this._exported = Gio.DBusExportedObject.wrapJSObject(interfaceXml(), impl);
            this._exported.export(connection, this._path);
            log.info(`[ipc]: exported name=${this._name} path=${this._path}`);
        } catch (e) {
            log.warn(`[ipc]: export failed: ${e.message}`);
            this._exported = null;
        }
    }

    stop() {
        try {
            this._exported?.unexport();
        } catch (e) {
            log.warn(`[ipc]: unexport failed: ${e.message}`);
        }
        this._exported = null;
        if (this._ownerId) {
            try {
                Gio.bus_unown_name(this._ownerId);
            } catch (e) {
                log.warn(`[ipc]: unown name failed: ${e.message}`);
            }
            this._ownerId = 0;
        }
    }
}
