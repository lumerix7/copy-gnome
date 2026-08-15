import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { loadConfig } from './config.js';
import { errorMessage } from './log.js';

const MAX_BYTES = 128 * 1024;

function readFile(path) {
    const file = Gio.File.new_for_path(path);
    let info;
    try {
        info = file.query_info('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, null);
    } catch (error) {
        if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw error;
    }
    if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > MAX_BYTES)
        throw new Error('expected a regular config file no larger than 128 KiB');

    const stream = file.read(null);
    try {
        const chunks = new Uint8Array(MAX_BYTES + 1);
        let size = 0;
        while (size < chunks.length) {
            const bytes = stream.read_bytes(chunks.length - size, null).get_data();
            if (!bytes.length)
                return new TextDecoder().decode(chunks.subarray(0, size));
            chunks.set(bytes, size);
            size += bytes.length;
        }
        throw new Error('config exceeds 128 KiB');
    } finally {
        stream.close(null);
    }
}

try {
    const config = loadConfig(ARGV[0], { quiet: true, readFile, strict: true });
    print(JSON.stringify({ ok: true, config }));
} catch (error) {
    print(JSON.stringify({
        ok: false,
        message: errorMessage(error).slice(0, 1600),
        stack: typeof error?.stack === 'string' ? error.stack.slice(0, 1600) : '',
    }));
}
