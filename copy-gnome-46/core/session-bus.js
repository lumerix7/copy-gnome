import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { log } from './log.js';

const CONNECT_TIMEOUT_MS = 2000;
let pending = null;

export function getSessionBus(timeoutMs = CONNECT_TIMEOUT_MS) {
    if (pending)
        return pending.work;

    const entry = {};
    pending = entry;
    entry.work = new Promise(resolve => {
        const request = new Gio.Cancellable();
        let timer = 0;
        let done = false;
        const finish = connection => {
            if (done)
                return;
            done = true;
            if (timer) {
                try {
                    GLib.Source.remove(timer);
                } catch (error) {
                    log.error('session bus deadline cleanup', error);
                }
            }
            log.debug('session bus connection finished');
            resolve(connection);
        };
        try {
            log.debug('session bus connection started');
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timer = 0;
                log.warn(`session bus connection timed out after ${timeoutMs} ms`);
                finish(null);
                try {
                    request.cancel();
                } catch (error) {
                    log.error('session bus connection cancel', error);
                }
                return GLib.SOURCE_REMOVE;
            });
            Gio.bus_get(Gio.BusType.SESSION, request, (_source, result) => {
                pending = null;
                try {
                    const connection = Gio.bus_get_finish(result);
                    if (!done)
                        log.info('session bus connected');
                    finish(connection);
                } catch (error) {
                    if (!done)
                        log.error('session bus connect', error);
                    finish(null);
                }
            });
        } catch (error) {
            pending = null;
            log.error('start session bus connection', error);
            finish(null);
        }
    });
    return entry.work;
}
