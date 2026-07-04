import GLib from 'gi://GLib';

import { log } from './log.js';

// Path resolution (see docs/05-config.md):
//   1. /opt/home/$USER as a durable alternate home, if writable
//   2. fallback: real $HOME XDG-style dirs

function tryMkdir(path) {
    return GLib.mkdir_with_parents(path, 0o700) === 0;
}

function homeConfigDir(home) {
    return GLib.build_filenamev([home, '.config', 'copy-gnome']);
}

function homeStateDir(home) {
    return GLib.build_filenamev([home, '.local', 'state', 'copy-gnome']);
}

function tryResolveHome(home) {
    const config = homeConfigDir(home);
    const data = homeStateDir(home);
    if (!tryMkdir(home) || !tryMkdir(config) || !tryMkdir(data))
        return null;
    return { config, data };
}

function xdgConfigHome(home) {
    const env = GLib.getenv('XDG_CONFIG_HOME');
    return env && env.length > 0 ? env : GLib.build_filenamev([home, '.config']);
}

function xdgStateHome(home) {
    const env = GLib.getenv('XDG_STATE_HOME');
    return env && env.length > 0 ? env : GLib.build_filenamev([home, '.local', 'state']);
}

function tryResolveXdg(home) {
    const config = GLib.build_filenamev([xdgConfigHome(home), 'copy-gnome']);
    const data = GLib.build_filenamev([xdgStateHome(home), 'copy-gnome']);
    if (!tryMkdir(config) || !tryMkdir(data))
        return null;
    return { config, data };
}

export class Paths {
    constructor() {
        this.base = null;
        this.config = null;
        this.data = null;
        this.usedFallback = false;
    }

    resolve() {
        const preferred = GLib.build_filenamev(['/opt/home', GLib.get_user_name()]);
        const fallback = GLib.get_home_dir();

        let dirs = tryResolveHome(preferred);
        let base = preferred;
        if (!dirs) {
            log.warn(`durable home "${preferred}" not writable; falling back to "${fallback}". ` +
                `Run scripts/setup-home.sh to use /opt/home.`);
            this.usedFallback = true;
            base = fallback;
            dirs = tryResolveXdg(base) ?? {
                config: GLib.build_filenamev([xdgConfigHome(base), 'copy-gnome']),
                data: GLib.build_filenamev([xdgStateHome(base), 'copy-gnome']),
            };
        }

        this.base = base;
        this.config = dirs.config;
        this.data = dirs.data;

        log.info(`home root: ${this.base}${this.usedFallback ? ' (fallback)' : ''}`);
        log.info(`config dir: ${this.config}`);
        log.info(`state dir: ${this.data}`);
        return this;
    }
}
