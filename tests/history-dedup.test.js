import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { History } from '../copy-gnome-50/core/history.js';
import { Store } from '../copy-gnome-50/core/store.js';
import { waitForHistoryWriter, writeHistorySnapshot } from '../copy-gnome-50/core/history-writer.js';

const PLAIN_MIME = 'text/plain;charset=utf-8';
const enc = new TextEncoder();

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function textRecord(id, value, usedAt, { mime = PLAIN_MIME } = {}) {
    const bytes = enc.encode(value).length;
    return {
        id,
        kind: 'text',
        mime,
        bytes,
        createdAt: usedAt,
        usedAt,
        payloads: [{ mime, encoding: 'utf8', value, bytes }],
    };
}

function textCapture(id, value, options = {}) {
    const { createdAt: _createdAt, usedAt: _usedAt, ...record } =
        textRecord(id, value, 0, options);
    return record;
}

function richRecord(id, rich, plain, usedAt, companion = 'rtf') {
    const richBytes = enc.encode(rich).length;
    const plainBytes = enc.encode(plain).length;
    const companionBytes = enc.encode(companion).length;
    const payloads = [
        { mime: 'text/html', encoding: 'utf8', value: rich, bytes: richBytes },
        { mime: PLAIN_MIME, encoding: 'utf8', value: plain, bytes: plainBytes },
        { mime: 'text/rtf', encoding: 'utf8', value: companion, bytes: companionBytes },
    ];
    return {
        id,
        kind: 'rich',
        mime: 'text/html',
        bytes: richBytes + plainBytes + companionBytes,
        createdAt: usedAt,
        usedAt,
        payloads,
    };
}

function richCapture(id, rich, plain, companion = 'rtf') {
    const { createdAt: _createdAt, usedAt: _usedAt, ...record } =
        richRecord(id, rich, plain, 0, companion);
    return record;
}

function indexedCount(history) {
    let count = 0;
    for (const bucket of history._contentIndex.values())
        count += bucket.size;
    return count;
}

function assertContentIdentity(record, message) {
    assert(Number.isInteger(record.contentBytes) && record.contentBytes >= 0,
        `${message}: contentBytes must be a non-negative integer`);
    assert(typeof record.contentSha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(record.contentSha256),
    `${message}: contentSha256 must be lowercase SHA-256`);
}

function harness(records, maxItems = 10) {
    const state = { changes: 0, snapshots: [], snapshotsDuringLoad: [] };
    const history = new History({
        opts: { maxItems },
        store: {
            appendSnapshot(items, gen) {
                state.snapshots.push({ items: items.slice(), gen });
            },
        },
        onChange: () => state.changes++,
    });
    history.load(records);
    state.snapshotsDuringLoad = state.snapshots.slice();
    state.changes = 0;
    state.snapshots = [];
    return { history, state };
}

function testOnlyNewHeadIsCompared() {
    const { history, state } = harness([
        textRecord('old-a-1', 'A', 400),
        textRecord('old-b-1', 'B', 300),
        textRecord('old-b-2', 'B', 200),
        textRecord('old-a-2', 'A', 100),
    ]);

    const head = history.add(textCapture('new-a', 'A'));
    const ids = history.list().map(record => record.id);

    assert(ids[0] === head.id && head.id === 'new-a', 'new record must remain the head');
    assert(!ids.includes('old-a-1') && !ids.includes('old-a-2'),
        'all older matches of the new head must be removed');
    assert(ids.includes('old-b-1') && ids.includes('old-b-2'),
        'older records must not be compared with each other');
    assert(state.snapshots.length === 1, 'batch dedup must queue one snapshot');
    assert(state.changes === 1, 'batch dedup must emit one change');
    assertContentIdentity(head, 'new record');
}

function testDedupRunsBeforeCapacityEviction() {
    const { history } = harness([
        textRecord('old-a', 'A', 300),
        textRecord('unique-b', 'B', 200),
        textRecord('unique-c', 'C', 100),
    ], 3);

    history.add(textCapture('new-a', 'A'));
    const ids = history.list().map(record => record.id);

    assert(ids.length === 3, 'replacing a duplicate at capacity must retain maxItems entries');
    assert(ids.includes('new-a'), 'new head must survive capacity handling');
    assert(ids.includes('unique-b') && ids.includes('unique-c'),
        'dedup must not evict an unrelated record');
    assert(!ids.includes('old-a'), 'older matching record must be removed');
}

function testPayloadIdentityIsExact() {
    const { history } = harness([
        textRecord('old-plain', 'same text', 100, { mime: 'text/plain' }),
    ]);

    history.add(textCapture('new-utf8', 'same text'));
    const ids = history.list().map(record => record.id);

    assert(ids.includes('new-utf8') && ids.includes('old-plain'),
        'different MIME/payload metadata must not be collapsed');
}

function testMultiPayloadIdentityIsExact() {
    const { history } = harness([
        richRecord('old-rich-1', '<b>A</b>', 'A', 300, '{\\rtf1 A}'),
        richRecord('old-rich-2', '<b>A</b>', 'A', 200, '{\\rtf1 A}'),
        richRecord('different-companion', '<b>A</b>', 'A', 100, '{\\rtf1 B}'),
    ]);

    history.add(richCapture('new-rich', '<b>A</b>', 'A', '{\\rtf1 A}'));
    const ids = history.list().map(record => record.id);

    assert(ids[0] === 'new-rich', 'new rich record must remain the head');
    assert(!ids.includes('old-rich-1') && !ids.includes('old-rich-2'),
        'all exact multi-payload matches must be removed');
    assert(ids.includes('different-companion'),
        'a different companion payload must keep the older record');
}

function testIndexTracksMutations() {
    const { history } = harness([
        textRecord('a', 'A', 300),
        textRecord('b', 'B', 200),
        textRecord('c', 'C', 100),
    ], 3);

    assert(indexedCount(history) === history.list().length, 'load must index every record');
    history.remove('b');
    assert(indexedCount(history) === history.list().length, 'remove must update the index');
    history.add(textCapture('d', 'D'));
    history.add(textCapture('e', 'E'));
    assert(indexedCount(history) === history.list().length, 'eviction must update the index');
    history.trimTo([textRecord('trimmed', 'T', 1)]);
    assert(indexedCount(history) === 1, 'trimTo must rebuild the index');
    history.clear();
    assert(indexedCount(history) === 0, 'clear must empty the index');
}

function testLoadDoesNotQueueCompatibilitySnapshot() {
    const first = harness([]);
    const record = first.history.add(textCapture('persisted', 'persisted value'));
    const persisted = {
        ...record,
        payloads: record.payloads.map(payload => ({ ...payload })),
    };
    const second = harness([persisted]);
    assert(second.state.snapshotsDuringLoad.length === 0,
        'loading the current format must not queue a compatibility snapshot');
    assertContentIdentity(second.history.list()[0], 'persisted record after reload');
}

function testCanonicalContentIdentityIsStable() {
    const { history } = harness([]);
    const record = history.add({
        ...textCapture('canonical', 'hello'),
        contentBytes: 0,
        contentSha256: '0'.repeat(64),
    });
    assert(record.contentBytes === 76, 'canonical byte length must use framed UTF-8 bytes');
    assert(record.contentSha256 ===
        'e79cc3efa4f0614fba20437f0317646990b53021365116ccd404cfe421b95b57',
    'canonical SHA-256 must remain stable');
}

function testDigestCandidateStillRequiresExactMatch() {
    const seedHarness = harness([]);
    const seed = seedHarness.history.add(textCapture('seed', 'A'));
    const forgedCollision = {
        ...textRecord('forged-collision', 'B', 1),
        contentBytes: seed.contentBytes,
        contentSha256: seed.contentSha256,
    };
    const { history } = harness([forgedCollision]);

    history.add(textCapture('new-a', 'A'));
    const ids = history.list().map(record => record.id);
    assert(ids.includes('new-a') && ids.includes('forged-collision'),
        'a digest candidate with different exact fields must never be deleted');
}

function removeTree(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return;
    if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = children.next_file(null)) !== null)
            removeTree(GLib.build_filenamev([path, info.get_name()]));
        children.close(null);
    }
    file.delete(null);
}

async function testStoreRoundTripsContentIdentity() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-test-XXXXXX');
    try {
        const store = new Store({ dataDir });
        const history = new History({
            opts: { maxItems: 10 },
            store,
            onChange: () => {},
        });
        history.load(await store.open());
        const added = history.add(textCapture('persisted', 'persist me'));
        assertContentIdentity(added, 'record before store flush');
        assert(await store.flush() === 'saved', 'store must flush the pending snapshot');
        const clipName = `clips-${GLib.DateTime.new_now_local().format('%Y%m%d')}.jsonl`;
        const clipPath = GLib.build_filenamev([dataDir, clipName]);
        const [readOk, contents] = GLib.file_get_contents(clipPath);
        assert(readOk, 'written snapshot must be readable');
        const snapshot = JSON.parse(new TextDecoder().decode(contents).trim());
        assert(!('version' in snapshot), 'snapshot must not write a version field');
        await store.close();

        const reopened = new Store({ dataDir });
        const records = await reopened.open();
        assert(records.length === 1, 'store reload must return the persisted record');
        assertContentIdentity(records[0], 'record after store reload');
        assert(records[0].contentBytes === added.contentBytes &&
            records[0].contentSha256 === added.contentSha256,
        'store must preserve the exact persisted content identity');
        await reopened.close();
    } finally {
        removeTree(dataDir);
    }
}

function todayClipName() {
    return `clips-${GLib.DateTime.new_now_local().format('%Y%m%d')}.jsonl`;
}

async function testCloseDoesNotBlockOnFifo() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-fifo-XXXXXX');
    try {
        const store = new Store({ dataDir });
        await store.open();
        const path = GLib.build_filenamev([dataDir, todayClipName()]);
        Gio.Subprocess.new(['mkfifo', path], Gio.SubprocessFlags.NONE).wait_check(null);
        store.appendSnapshot([harness([]).history.add(textCapture('fifo', 'pending'))]);
        let ticks = 0;
        const tick = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            ticks++;
            return GLib.SOURCE_REMOVE;
        });
        try {
            const work = store.close();
            assert(work === store.close(), 'repeat close must reuse the final write');
            assert(await work === 'failed' && ticks === 1, 'refusing a FIFO must leave the event loop responsive');
        } finally {
            if (ticks === 0)
                GLib.Source.remove(tick);
        }
        assert(Gio.File.new_for_path(path).query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.SPECIAL,
            'close must leave the FIFO untouched');
    } finally {
        removeTree(dataDir);
    }
}

async function testFlushStatuses() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-flush-status-XXXXXX');
    let notifications = 0;
    const store = new Store({ dataDir, onNewDailyFile() {
        notifications++;
        throw new Error('fixture post-save notification failure');
    } });
    try {
        await store.open();
        const path = GLib.build_filenamev([dataDir, todayClipName()]);
        GLib.mkdir_with_parents(path, 0o700);
        const record = harness([]).history.add(textCapture('pending', 'save status'));
        store.appendSnapshot([record]);
        const writing = store.flush();
        const repeated = await store.flush();
        assert(await writing === 'failed', 'a directory must refuse the snapshot write');
        assert(repeated === 'busy', 'a repeated save with no newer batch must report the outstanding write');
        assert(await store.flush() === 'failed', 'a dropped batch must retain its failed status');
        GLib.rmdir(path);
        store.appendSnapshot([record]);
        assert(await store.flush() === 'saved' && await store.flush() === 'idle',
            'a successful new snapshot must restore the already-saved status');
        assert(notifications === 1, 'post-save notification failure must preserve the successful write status');
        store.appendSnapshot([{ ...record, contentSha256: null }]);
        assert(await store.flush() === 'failed' && await store.flush() === 'failed',
            'snapshot preparation failures must also remain visible');
    } finally {
        await store.close();
        removeTree(dataDir);
    }
}

async function testHistoryWriteSlot() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-slot-XXXXXX');
    const close = Gio.OutputStream.prototype.close_async;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let entered;
    const closing = new Promise(resolve => { entered = resolve; });
    let hold = true;
    Gio.OutputStream.prototype.close_async = function (...args) {
        if (!hold)
            return close.apply(this, args);
        hold = false;
        entered();
        return gate.then(() => close.apply(this, args));
    };
    try {
        const oldStore = new Store({ dataDir });
        const newStore = new Store({ dataDir: `${dataDir}/.` });
        await oldStore.open();
        const makeItem = (id, value) => harness([]).history.add(textCapture(id, value));
        oldStore.appendSnapshot([makeItem('first', 'old in-flight write')]);
        const first = oldStore.flush();
        await closing;
        const path = GLib.build_filenamev([dataDir, todayClipName()]);
        assert(await waitForHistoryWriter(path, 10) === false, 'a wait deadline must not release a writer still closing');
        const nextLoad = newStore.open();
        oldStore.appendSnapshot([makeItem('closing', 'latest snapshot from the retiring store')]);
        const final = oldStore.close();
        const queued = writeHistorySnapshot(path, [makeItem('replacement', 'later final snapshot')], true);
        assert(await final === 'superseded', 'only the newest queued final snapshot may survive');
        newStore.appendSnapshot([makeItem('second', 'first fresh pending snapshot')]);
        assert(await newStore.flush() === 'busy', 'a new instance must not start writing before close has ended');
        const value = 'a'.repeat(65535) + '😀\\\n\t"漢字';
        newStore.appendSnapshot([makeItem('latest', value)]);
        release();
        assert(await first === 'saved', 'first append should settle');
        assert((await queued).status === 'saved', 'the newest final append must settle after the first');
        assert((await nextLoad)[0]?.id === 'replacement', 'a new instance must wait for the final snapshot before reading');
        assert(await newStore.flush() === 'saved', 'the new instance must retain its newest pending batch');
        const reader = new Store({ dataDir });
        const [latest] = await reader.open();
        assert(latest?.id === 'latest' && latest.payloads[0].value === value,
            'the newest snapshot must remain last and exact across Unicode and JSON block boundaries');
        await reader.close();
        await newStore.close();
    } finally {
        release();
        Gio.OutputStream.prototype.close_async = close;
        removeTree(dataDir);
    }
}

function pastClipName(daysAgo) {
    const dt = GLib.DateTime.new_now_local().add_days(-daysAgo);
    return `clips-${dt.format('%Y%m%d')}.jsonl`;
}

function writeSnapshotFile(path, records) {
    const line = JSON.stringify({ type: 'history', writtenAt: GLib.get_real_time(), items: records });
    GLib.file_set_contents(path, `${line}\n`);
}

async function testSnapshotRecovery() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-recovery-XXXXXX');
    const path = GLib.build_filenamev([dataDir, todayClipName()]);
    const old = harness([]).history.add(textCapture('intact', 'kept record'));
    const partial = harness([]).history.add(textCapture('torn', 'x'.repeat(300000)));
    try {
        writeSnapshotFile(path, [old]);
        const original = new Store({ dataDir });
        await original.open();
        original.appendSnapshot([partial]);
        const write = Gio.OutputStream.prototype.write_bytes_async;
        let writes = 0;
        try {
            Gio.OutputStream.prototype.write_bytes_async = function (...args) {
                if (++writes === 2)
                    return Promise.reject(new Error('fixture interrupted second block'));
                return write.apply(this, args);
            };
            assert(await original.flush() === 'failed' && writes === 2, 'fixture must leave a torn line');
        } finally {
            Gio.OutputStream.prototype.write_bytes_async = write;
        }
        await original.close();
        const reopened = new Store({ dataDir });
        assert((await reopened.open())[0]?.id === 'intact', 'backward scan must recover the intact line behind a multi-block failure');
        await reopened.close();

        const intact = JSON.stringify({ type: 'history', writtenAt: 1, items: [old] });
        const cleared = JSON.stringify({ type: 'history', writtenAt: 2, items: [] });
        GLib.file_set_contents(path, `${intact}\n${cleared}\ntorn\n`);
        const empty = new Store({ dataDir });
        assert((await empty.open()).length === 0, 'a valid clear must stop recovery');
        empty.appendSnapshot([old]);
        assert(await empty.flush() === 'saved', 'a valid clear must leave persistence available');
        await empty.close();

        for (const broken of [9, 10]) {
            GLib.file_set_contents(path, `${intact}\n${'invalid\n'.repeat(broken)}`);
            const bounded = new Store({ dataDir });
            const records = await bounded.open();
            assert(records.length === (broken === 9 ? 1 : 0), 'recovery must examine at most ten lines');
            if (broken === 10) {
                bounded.appendSnapshot([partial]);
                assert(await bounded.flush() === 'failed', 'unresolved recovery must leave durable history alone');
            }
            await bounded.close();
        }
    } finally {
        removeTree(dataDir);
    }
}

async function testDirectoryDeadlineAndRetirement() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-directory-XXXXXX');
    const enumerate = Gio.File.prototype.enumerate_children_async;
    const timeout = GLib.timeout_add_seconds;
    let release, enter, inFlight;
    let scans = 0;
    const held = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { enter = resolve; });
    try {
        const store = new Store({ dataDir });
        const path = GLib.build_filenamev([dataDir, pastClipName(8)]);
        writeSnapshotFile(path, []);
        Gio.File.prototype.enumerate_children_async = function (...args) {
            scans++;
            enter(args.at(-1));
            inFlight = held.then(() => enumerate.apply(this, args));
            return inFlight;
        };
        GLib.timeout_add_seconds = (priority, seconds, callback) =>
            seconds === 5 ? GLib.timeout_add(priority, 35, callback) : timeout(priority, seconds, callback);
        const startup = store.open();
        const request = await entered;
        let responsive = false;
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
            responsive = true;
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        assert(responsive && (await startup).length === 0 && request.is_cancelled(),
            'a stalled scan must time out while the main loop remains responsive');
        const second = new Store({ dataDir });
        assert((await second.open()).length === 0 && scans === 1,
            'another instance must not queue more native startup work');
        await store.close();
        await second.close();
        release();
        await inFlight.catch(() => {});

        Gio.File.prototype.enumerate_children_async = enumerate;
        GLib.timeout_add_seconds = timeout;
        const next = new Store({ dataDir });
        const files = Gio.FileEnumerator.prototype.next_files_async;
        let unblock, started, batch;
        const gate = new Promise(resolve => { unblock = resolve; });
        const start = new Promise(resolve => { started = resolve; });
        Gio.FileEnumerator.prototype.next_files_async = function (...args) {
            started(args.at(-1));
            batch = gate.then(() => files.apply(this, args));
            return batch;
        };
        try {
            const sweep = next.sweepOldFiles(3);
            const sweepRequest = await start;
            await next.close();
            await sweep;
            assert(sweepRequest.is_cancelled(), 'close must cancel an outstanding directory batch');
            unblock();
            await batch.catch(() => {});
            assert(GLib.file_test(path, GLib.FileTest.IS_REGULAR), 'a retired scan must not delete a file');
        } finally {
            unblock();
            Gio.FileEnumerator.prototype.next_files_async = files;
        }
    } finally {
        release();
        Gio.File.prototype.enumerate_children_async = enumerate;
        GLib.timeout_add_seconds = timeout;
        removeTree(dataDir);
    }
}

// Mirrors extension.js's _rehomeRecoveredSnapshot() gating condition - keep in sync: only
// re-home a cross-day recovery once its age has actually reached maxAgeDays, i.e. the sweep
// that follows would otherwise delete it. A younger fallback file is left for a later real
// copy to re-home, same as an ordinary daily reboot.
function shouldRehome(store, maxAgeDays) {
    return store.recoveredFromOlderFile && maxAgeDays > 0 &&
        Number.isInteger(store.recoveredFileAgeDays) && store.recoveredFileAgeDays >= maxAgeDays;
}

async function testRecoveredSnapshotIsRehomedBeforeSweep() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-rehome-test-XXXXXX');
    try {
        const seed = harness([]).history.add(textCapture('old-day', 'still needed'));
        const oldName = pastClipName(9);
        writeSnapshotFile(GLib.build_filenamev([dataDir, oldName]), [seed]);

        const store = new Store({ dataDir });
        const records = await store.open();
        assert(records.length === 1, 'startup must recover the record from the older file');
        assert(store.recoveredFromOlderFile === true,
            'store must flag a cross-day recovery so the caller considers re-homing it');
        assert(store.recoveredFileAgeDays === 9, 'recovered file age must be exposed in whole days');
        assert(shouldRehome(store, 3) === true,
            'a 9-day-old file with maxAgeDays=3 is already sweep-eligible and must be re-homed');

        // Mirrors extension.js's _rehomeRecoveredSnapshot(): persist once, before any sweep.
        const history = new History({ opts: { maxItems: 10 }, store, onChange: () => {} });
        history.load(records);
        history.persistSnapshot();
        assert(await store.flush() === 'saved', 'recovered snapshot must flush to today\'s file');

        const todayPath = GLib.build_filenamev([dataDir, todayClipName()]);
        assert(Gio.File.new_for_path(todayPath).query_exists(null),
            'today\'s file must exist before the sweep runs');

        await store.sweepOldFiles(3);
        const oldPath = GLib.build_filenamev([dataDir, oldName]);
        assert(!Gio.File.new_for_path(oldPath).query_exists(null),
            'the now-superseded older file must still be swept');

        const reopened = new Store({ dataDir });
        const survivors = await reopened.open();
        assert(survivors.length === 1 && survivors[0].contentSha256 === seed.contentSha256,
            'the record must survive the sweep because it was re-homed first');
        assert(reopened.recoveredFromOlderFile === false,
            'a same-day reload must not be flagged as a cross-day recovery');
        await reopened.close();
        await store.close();
    } finally {
        removeTree(dataDir);
    }
}

async function testFailedRehomeKeepsFallback() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-failed-rehome-XXXXXX');
    try {
        const seed = harness([]).history.add(textCapture('fallback', 'only valid snapshot'));
        const oldPath = GLib.build_filenamev([dataDir, pastClipName(9)]);
        writeSnapshotFile(oldPath, [seed]);
        const store = new Store({ dataDir });
        const records = await store.open();
        assert(records[0]?.id === 'fallback', 'the old snapshot is the source for the re-home');
        const path = GLib.build_filenamev([dataDir, todayClipName()]);
        const write = Gio.OutputStream.prototype.write_bytes_async;
        try {
            Gio.OutputStream.prototype.write_bytes_async = () => Promise.reject(new Error('fixture first write failure'));
            store.appendSnapshot(records);
            assert(await store.flush() === 'failed' && GLib.file_test(path, GLib.FileTest.IS_REGULAR),
                'failed re-home must leave an unreadable newer file for the test');
        } finally {
            Gio.OutputStream.prototype.write_bytes_async = write;
        }
        await store.sweepOldFiles(3);
        await store.sweepOldFiles(3);
        assert(GLib.file_test(oldPath, GLib.FileTest.IS_REGULAR), 'startup and periodic sweeps must keep the only snapshot');
        await store.close();

        const restarted = new Store({ dataDir });
        const reloaded = await restarted.open();
        assert(reloaded[0]?.id === 'fallback', 'a failed target must not hide the only valid snapshot');
        await restarted.sweepOldFiles(3);
        assert(GLib.file_test(oldPath, GLib.FileTest.IS_REGULAR), 'an unreadable newer file must not expose the fallback to retention');
        const torn = '{"type":"history","items":[';
        GLib.file_set_contents(path, torn);
        const newer = harness([]).history.add(textCapture('new', 'later capture'));
        restarted.appendSnapshot([newer, ...reloaded]);
        assert(await restarted.flush() === 'saved', 'a new append must work after a torn write');
        await restarted.sweepOldFiles(3);
        assert(!GLib.file_test(oldPath, GLib.FileTest.EXISTS), 'retention may resume after a complete saved snapshot');
        const reader = new Store({ dataDir });
        assert((await reader.open()).some(record => record.id === 'fallback'), 'the recovered record must survive restart');
        const [ok, bytes] = GLib.file_get_contents(path);
        assert(ok && new TextDecoder().decode(bytes).startsWith(`${torn}\n`), 'the append must preserve the previous bytes');
        await reader.close();
        await restarted.close();
    } finally {
        removeTree(dataDir);
    }
}

async function testSameDayLoadIsNotRehomed() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-noop-rehome-test-XXXXXX');
    try {
        const seed = harness([]).history.add(textCapture('today', 'already home'));
        writeSnapshotFile(GLib.build_filenamev([dataDir, todayClipName()]), [seed]);

        const store = new Store({ dataDir });
        const records = await store.open();
        assert(records.length === 1, 'startup must load today\'s own file');
        assert(store.recoveredFromOlderFile === false,
            'loading today\'s own file must never be flagged as a cross-day recovery');
        assert(store.recoveredFileAgeDays === null,
            'recoveredFileAgeDays must be null when there was no cross-day recovery');

        const history = new History({ opts: { maxItems: 10 }, store, onChange: () => {} });
        history.load(records);
        assert(await store.flush() === 'idle',
            'a same-day load must not queue a redundant re-home snapshot');
        await store.close();
    } finally {
        removeTree(dataDir);
    }
}

async function testYoungFallbackFileIsNotRehomed() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-young-rehome-test-XXXXXX');
    try {
        const seed = harness([]).history.add(textCapture('yesterday', 'ordinary daily reboot'));
        writeSnapshotFile(GLib.build_filenamev([dataDir, pastClipName(1)]), [seed]);

        const store = new Store({ dataDir });
        const records = await store.open();
        assert(records.length === 1, 'startup must recover the record from yesterday\'s file');
        assert(store.recoveredFromOlderFile === true,
            'loading yesterday\'s file is still a cross-day recovery mechanically');
        assert(store.recoveredFileAgeDays === 1, 'the fallback file must be exactly 1 day old');
        assert(shouldRehome(store, 3) === false,
            'a 1-day-old file is not yet sweep-eligible under the default maxAgeDays=3 and ' +
            'must not force an extra write on an ordinary daily reboot');

        const history = new History({ opts: { maxItems: 10 }, store, onChange: () => {} });
        history.load(records);
        // shouldRehome is false, so extension.js never calls persistSnapshot() here.
        assert(await store.flush() === 'idle',
            'an ordinary (not yet sweep-eligible) cross-day recovery must not queue a write');
        await store.close();
    } finally {
        removeTree(dataDir);
    }
}

async function testFallbackFileExactlyAtMaxAgeIsRehomed() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-boundary-rehome-test-XXXXXX');
    try {
        const seed = harness([]).history.add(textCapture('boundary-day', 'right at the edge'));
        const oldName = pastClipName(3);
        writeSnapshotFile(GLib.build_filenamev([dataDir, oldName]), [seed]);

        const store = new Store({ dataDir });
        const records = await store.open();
        assert(store.recoveredFileAgeDays === 3, 'the fallback file must be exactly 3 days old');
        assert(shouldRehome(store, 3) === true,
            'a file exactly at maxAgeDays must be re-homed one day before the sweep would ' +
            'otherwise delete it, closing the race between open() and the sweep that follows');

        const history = new History({ opts: { maxItems: 10 }, store, onChange: () => {} });
        history.load(records);
        history.persistSnapshot();
        assert(await store.flush() === 'saved', 'recovered snapshot must flush to today\'s file');

        // The sweep itself only deletes when ageDays > maxAgeDays (strictly older), so a file
        // exactly at the boundary is not deleted this pass - the re-home above does not depend
        // on that, since the data is already safe in today's file either way.
        await store.sweepOldFiles(3);
        const oldPath = GLib.build_filenamev([dataDir, oldName]);
        assert(Gio.File.new_for_path(oldPath).query_exists(null),
            'a file exactly at maxAgeDays is not deleted by this sweep pass yet');
        await store.close();
    } finally {
        removeTree(dataDir);
    }
}

async function testStoreRejectsMissingContentIdentity() {
    const dataDir = GLib.dir_make_tmp('copy-gnome-store-invalid-test-XXXXXX');
    try {
        const clipName = `clips-${GLib.DateTime.new_now_local().format('%Y%m%d')}.jsonl`;
        const clipPath = GLib.build_filenamev([dataDir, clipName]);
        const current = harness([]).history.add(textCapture('current', 'current shape'));
        GLib.file_set_contents(clipPath, `${JSON.stringify({
            type: 'history',
            writtenAt: 1,
            items: [current, textRecord('missing-identity', 'old shape', 1)],
        })}\n`);
        const store = new Store({ dataDir });
        const records = await store.open();
        assert(records.length === 0,
            'one record missing required content identity must reject the whole snapshot');
        await store.close();
    } finally {
        removeTree(dataDir);
    }
}

testOnlyNewHeadIsCompared();
testDedupRunsBeforeCapacityEviction();
testPayloadIdentityIsExact();
testMultiPayloadIdentityIsExact();
testIndexTracksMutations();
testLoadDoesNotQueueCompatibilitySnapshot();
testCanonicalContentIdentityIsStable();
testDigestCandidateStillRequiresExactMatch();
await testStoreRoundTripsContentIdentity();
await testCloseDoesNotBlockOnFifo();
await testHistoryWriteSlot();
await testFlushStatuses();
await testStoreRejectsMissingContentIdentity();
await testSnapshotRecovery();
await testDirectoryDeadlineAndRetirement();
await testRecoveredSnapshotIsRehomedBeforeSweep();
await testFailedRehomeKeepsFallback();
await testSameDayLoadIsNotRehomed();
await testYoungFallbackFileIsNotRehomed();
await testFallbackFileExactlyAtMaxAgeIsRehomed();
console.log('history dedup tests passed');
