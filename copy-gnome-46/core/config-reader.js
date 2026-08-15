import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { log } from './log.js';

const worker = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('config-worker.js').get_path();
const READ_TIMEOUT_MS = 1500;

// A stuck native open is confined to the worker. This operation receives only
// a directory string and returns a detached config object.
export function readConfigSnapshot(dir, timeoutMs = READ_TIMEOUT_MS) {
    let stop = () => {};
    const work = new Promise(resolve => {
        let process = null;
        let timer = 0;
        let done = false;
        const request = new Gio.Cancellable();
        const finish = config => {
            if (done)
                return;
            done = true;
            const id = timer;
            timer = 0;
            if (id) {
                try {
                    GLib.Source.remove(id);
                } catch (error) {
                    log.error('config deadline cleanup', error);
                }
            }
            log.debug('config read finished');
            resolve(config);
        };
        stop = () => {
            if (done)
                return;
            finish(null);
            try {
                request.cancel();
            } catch (error) {
                log.error('config request cancel', error);
            }
            try {
                process?.force_exit();
            } catch (error) {
                log.error('config worker stop', error);
            }
        };
        try {
            log.debug('config read started');
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            launcher.setenv('GIO_USE_VFS', 'local', true);
            process = launcher.spawnv(['gjs', '-m', worker, dir]);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timer = 0;
                log.warn(`config read timed out after ${timeoutMs} ms`);
                stop();
                return GLib.SOURCE_REMOVE;
            });
            process.communicate_utf8_async(null, request, (child, result) => {
                try {
                    const [ok, json] = child.communicate_utf8_finish(result);
                    if (done)
                        return;
                    if (!ok || !child.get_successful())
                        throw new Error('config worker failed');
                    const reply = JSON.parse(json);
                    if (!reply.ok) {
                        log.error('config worker', reply);
                        finish(null);
                        return;
                    }
                    finish(reply.config);
                } catch (error) {
                    if (!done)
                        log.error('config worker reply', error);
                    finish(null);
                }
            });
        } catch (error) {
            log.error('start config read', error);
            stop();
        }
    });
    return { work, cancel: () => stop() };
}
