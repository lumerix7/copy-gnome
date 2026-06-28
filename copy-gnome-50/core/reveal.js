import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { log } from './log.js';

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
export function uriExists(uri, timeoutMs = EXISTS_TIMEOUT_MS) {
    return new Promise(resolve => {
        let done = false;
        let timer = 0;
        const finish = exists => {
            if (done)
                return;
            done = true;
            if (timer) {
                try {
                    GLib.Source.remove(timer);
                } catch (e) {
                    log.debug(`[reveal]: exists timer cleanup failed: ${e.message}`);
                }
                timer = 0;
            }
            resolve(exists);
        };
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timer = 0;
            log.debug(`[reveal]: exists check timed out uri=${uri}`);
            finish(true);
            return GLib.SOURCE_REMOVE;
        });
        try {
            Gio.File.new_for_uri(uri).query_info_async(
                'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
                (file, res) => {
                    try {
                        file.query_info_finish(res);
                        finish(true);
                    } catch (e) {
                        const notFound = e instanceof GLib.Error &&
                            e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
                        if (!notFound)
                            log.debug(`[reveal]: exists check error uri=${uri}: ${e.message}`);
                        finish(!notFound);
                    }
                });
        } catch (e) {
            log.debug(`[reveal]: exists check setup failed uri=${uri}: ${e.message}`);
            finish(true);
        }
    });
}

/** @returns {Promise<{existing: string[], missing: string[]}>} preserves input order. */
export async function partitionExistingUris(uris) {
    const checks = await Promise.all(uris.map(uri => uriExists(uri).then(ok => ({ uri, ok }))));
    return {
        existing: checks.filter(c => c.ok).map(c => c.uri),
        missing: checks.filter(c => !c.ok).map(c => c.uri),
    };
}

/**
 * Reveal (select) the uris in the session file manager; falls back to opening the first
 * uri's parent folder with the default handler when no FileManager1 implementation
 * answers. Resolves true when something was shown. Never rejects.
 */
export function showInFileManager(uris) {
    return new Promise(resolve => {
        if (!Array.isArray(uris) || uris.length === 0) {
            resolve(false);
            return;
        }
        try {
            Gio.DBus.session.call(
                FILE_MANAGER_BUS, FILE_MANAGER_PATH, FILE_MANAGER_IFACE, 'ShowItems',
                new GLib.Variant('(ass)', [uris, '']),
                null, Gio.DBusCallFlags.NONE, SHOW_ITEMS_TIMEOUT_MS, null,
                (connection, res) => {
                    try {
                        connection.call_finish(res);
                        log.debug(`[reveal]: ShowItems ok uris=${uris.length}`);
                        resolve(true);
                    } catch (e) {
                        log.debug(`[reveal]: ShowItems failed, falling back: ${e.message}`);
                        resolve(openParentFolder(uris[0]));
                    }
                });
        } catch (e) {
            log.debug(`[reveal]: ShowItems call setup failed: ${e.message}`);
            resolve(openParentFolder(uris[0]));
        }
    });
}

function openParentFolder(uri) {
    try {
        const parent = Gio.File.new_for_uri(uri).get_parent();
        const target = parent ? parent.get_uri() : uri;
        Gio.AppInfo.launch_default_for_uri(target, null);
        log.debug(`[reveal]: opened folder ${target}`);
        return true;
    } catch (e) {
        log.warn(`[reveal]: open folder failed uri=${uri}: ${e.message}`);
        return false;
    }
}
