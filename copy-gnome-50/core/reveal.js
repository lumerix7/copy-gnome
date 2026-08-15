import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { log } from './log.js';
import { getSessionBus } from './session-bus.js';

// "Show in Files" for file records (docs/07-ui.md). Reveal goes through the freedesktop
// `org.freedesktop.FileManager1.ShowItems` DBus interface - the session's default file
// manager owns that name (Nautilus, Nemo, Dolphin, ...) and selects the items, so no
// file-manager config is needed. Existence is checked here first so a stale record shows
// our own hint instead of a file-manager error dialog. Fail-closed: failures resolve to
// false/true-ish defaults and log with the `[reveal]:` prefix; nothing throws into the
// Shell.

const FILE_MANAGER_BUS = 'org.freedesktop.FileManager1';
const FILE_MANAGER_PATH = '/org/freedesktop/FileManager1';
const FILE_MANAGER_IFACE = 'org.freedesktop.FileManager1';
const SHOW_ITEMS_TIMEOUT_MS = 5000;
// Slow (network) mounts: a check that cannot answer in time counts as existing and the
// file manager deals with it - only a definite NOT_FOUND marks a file missing.
const EXISTS_TIMEOUT_MS = 1500;

/** @returns {Promise<boolean>} false only on a definite NOT_FOUND. Never rejects. */
export function uriExists(uri, timeoutMs = EXISTS_TIMEOUT_MS, cancellable = null) {
    return new Promise(resolve => {
        log.debug(`[reveal]: exists check started uri=${uri}`);
        const request = new Gio.Cancellable();
        let done = false;
        let deadline = null;
        let parentId = 0;
        const cancelQuery = () => {
            try {
                request.cancel();
            } catch (error) {
                log.error('[reveal]: cancel existence query', error);
            }
        };
        const finish = exists => {
            if (done)
                return;
            done = true;
            if (deadline) {
                try {
                    deadline.destroy();
                } catch (e) {
                    log.error('[reveal]: exists timer cleanup failed', e);
                }
                deadline = null;
            }
            if (parentId) {
                try {
                    cancellable.disconnect(parentId);
                } catch (error) {
                    log.error('[reveal]: cancellation handler cleanup', error);
                }
                parentId = 0;
            }
            log.debug(`[reveal]: exists check finished uri=${uri} existing=${exists}`);
            resolve(exists);
        };
        try {
            if (cancellable?.is_cancelled()) {
                finish(true);
                return;
            }
            deadline = GLib.timeout_source_new(timeoutMs);
            deadline.set_callback(() => {
                if (done)
                    return GLib.SOURCE_REMOVE;
                deadline = null;
                if (cancellable?.is_cancelled()) {
                    log.debug(`[reveal]: exists check cancelled uri=${uri}`);
                    finish(true);
                } else {
                    log.warn(`[reveal]: exists check timed out uri=${uri}`);
                    finish(true);
                    cancelQuery();
                }
                return GLib.SOURCE_REMOVE;
            });
            deadline.attach(null);
            if (cancellable) {
                parentId = cancellable.connect(() => {
                    cancelQuery();
                    // Finish and disconnect on the main loop, outside Gio's cancelled signal.
                    try {
                        deadline?.set_ready_time(0);
                    } catch (error) {
                        log.error('[reveal]: dispatch existence query cancellation', error);
                    }
                });
                if (cancellable.is_cancelled())
                    return;
            }
            Gio.File.new_for_uri(uri).query_info_async(
                'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, request,
                (file, res) => {
                    let exists = true;
                    try {
                        file.query_info_finish(res);
                    } catch (e) {
                        const notFound = e instanceof GLib.Error &&
                            e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
                        if (!done && !notFound && !request.is_cancelled())
                            log.error(`[reveal]: exists check error uri=${uri}`, e);
                        exists = !notFound;
                    }
                    if (!cancellable?.is_cancelled())
                        finish(exists);
                });
        } catch (e) {
            log.error(`[reveal]: exists check setup failed uri=${uri}`, e);
            finish(true);
        }
    });
}

/** @returns {Promise<{existing: string[], missing: string[]}>} preserves input order. */
export async function partitionExistingUris(uris, cancellable = null) {
    const deadline = GLib.get_monotonic_time() + EXISTS_TIMEOUT_MS * 1000;
    const missing = new Set();
    let next = 0;
    const check = async () => {
        while (next < uris.length && !cancellable?.is_cancelled()) {
            const remaining = Math.floor((deadline - GLib.get_monotonic_time()) / 1000);
            if (remaining < 1)
                return;
            const i = next++;
            if (!await uriExists(uris[i], remaining, cancellable))
                missing.add(i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(uris.length, 8) }, check));
    return {
        existing: uris.filter((_uri, i) => !missing.has(i)),
        missing: uris.filter((_uri, i) => missing.has(i)),
    };
}

/**
 * Reveal (select) the uris in the session file manager; falls back to opening the first
 * uri's parent folder with the default handler when no FileManager1 implementation
 * answers. Resolves true when something was shown. Never rejects.
 */
export async function showInFileManager(uris, cancellable = null) {
    if (!Array.isArray(uris) || !uris.length || cancellable?.is_cancelled())
        return false;
    const request = cancellable ?? new Gio.Cancellable();
    const connection = await getSessionBus();
    if (request.is_cancelled())
        return false;
    if (connection && await showItems(connection, uris, request))
        return true;
    if (request.is_cancelled())
        return false;
    return openParentFolder(uris[0], request);
}

function showItems(connection, uris, request) {
    return new Promise(resolve => {
        log.debug('[reveal]: ShowItems started');
        try {
            connection.call(
                FILE_MANAGER_BUS, FILE_MANAGER_PATH, FILE_MANAGER_IFACE, 'ShowItems',
                new GLib.Variant('(ass)', [uris, '']),
                null, Gio.DBusCallFlags.NONE, SHOW_ITEMS_TIMEOUT_MS, request,
                (bus, res) => {
                    try {
                        bus.call_finish(res);
                        log.debug(`[reveal]: ShowItems finished uris=${uris.length}`);
                        resolve(!request.is_cancelled());
                    } catch (error) {
                        if (!request.is_cancelled())
                            log.warn('[reveal]: ShowItems failed, falling back', error);
                        resolve(false);
                    }
                });
        } catch (error) {
            log.error('[reveal]: ShowItems call setup failed', error);
            resolve(false);
        }
    });
}

function openParentFolder(uri, request) {
    return new Promise(resolve => {
        let timer = 0;
        let done = false;
        const finish = shown => {
            if (done)
                return;
            done = true;
            if (timer) {
                try {
                    GLib.Source.remove(timer);
                } catch (error) {
                    log.error('[reveal]: parent folder timer cleanup', error);
                }
            }
            resolve(shown);
        };
        try {
            const parent = Gio.File.new_for_uri(uri).get_parent();
            const target = parent?.get_uri() ?? uri;
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOW_ITEMS_TIMEOUT_MS, () => {
                timer = 0;
                log.warn('[reveal]: parent folder request timed out');
                finish(false);
                try {
                    request.cancel();
                } catch (error) {
                    log.error('[reveal]: parent folder request cancel', error);
                }
                return GLib.SOURCE_REMOVE;
            });
            Gio.AppInfo.launch_default_for_uri_async(target, null, request, (_source, res) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(res);
                    if (!done && !request.is_cancelled())
                        log.debug(`[reveal]: opened folder ${target}`);
                    finish(!request.is_cancelled());
                } catch (error) {
                    if (!done && !request.is_cancelled())
                        log.error('[reveal]: open folder failed', error);
                    finish(false);
                }
            });
        } catch (error) {
            log.error('[reveal]: open folder setup failed', error);
            finish(false);
        }
    });
}
