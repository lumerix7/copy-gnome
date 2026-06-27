import GLib from 'gi://GLib';

import { log } from './log.js';

// Data home resolution (see docs/05-config.md):
//   1. $COPY_GNOME_HOME if set & writable
//   2. /opt/copy-gnome/$USER  (deliberately off $HOME)
//   3. fallback: $XDG_DATA_HOME/copy-gnome   (only if the above is not writable)

function tryMkdir(path) {
    return GLib.mkdir_with_parents(path, 0o700) === 0;
}

export class Paths {
    constructor() {
        this.base = null;
        this.config = null;
        this.data = null;
        this.usedFallback = false;
    }

    resolve() {
        const env = GLib.getenv('COPY_GNOME_HOME');
        let base;
        if (env && env.length > 0)
            base = env;
        else
            base = GLib.build_filenamev(['/opt/copy-gnome', GLib.get_user_name()]);

        if (!tryMkdir(base)) {
            const fallback = GLib.build_filenamev([GLib.get_user_data_dir(), 'copy-gnome']);
            log.warn(`data home "${base}" not writable; falling back to "${fallback}". ` +
                `Run scripts/setup-home.sh to use /opt/copy-gnome, or set COPY_GNOME_HOME.`);
            base = fallback;
            this.usedFallback = true;
            tryMkdir(base);
        }

        this.base = base;
        this.config = GLib.build_filenamev([base, 'config']);
        this.data = this.usedFallback ? base : GLib.build_filenamev([base, 'data']);

        for (const d of [this.config, this.data])
            tryMkdir(d);

        log.info(`data home: ${this.base}${this.usedFallback ? ' (fallback)' : ''}`);
        log.info(`data dir: ${this.data}`);
        return this;
    }
}
