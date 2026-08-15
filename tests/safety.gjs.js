import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { Completions } from '../copy-gnome-50/core/completions.js';
import { log, setLevel } from '../copy-gnome-50/core/log.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function loggingProbe() {
    setLevel('error');
    log.warn('filtered warning');
    log.error('capture stage', new Error('injected'));
    log.error('invalid thrown value', {
        get message() { throw new Error('message getter failed'); },
        get stack() { throw new Error('stack getter failed'); },
    });
    for (let i = 0; i < 40; i++)
        log.error('bounded message ' + 'x'.repeat(8000));
    log.error('distinct late error', new Error('preserved'));
}

async function testRetiredCompletions() {
    const scope = new Completions();
    let finish;
    let replies = 0;
    let cancelled = 0;
    const work = new Promise(resolve => { finish = resolve; });
    scope.add('pending test', work, () => replies++, () => cancelled++);
    const notify = scope.listen('retention test', () => replies++);
    notify('already queued');
    scope.close();
    scope.close();
    finish('late payload');
    notify('late signal');

    const active = new Completions();
    await new Promise(resolve => active.add('active test', Promise.resolve('detached'), result => {
        assert(result.ok && result.value === 'detached', 'active completion must deliver its data');
        resolve();
    }));
    active.close();
    assert(cancelled === 1 && replies === 0, 'retiring must cancel once and prevent callbacks');
}

async function testRetiredTimers() {
    const scope = new Completions();
    const add = GLib.timeout_add_seconds;
    const remove = GLib.Source.remove;
    const timers = [];
    const removals = [];
    let ticks = 0;
    GLib.timeout_add_seconds = (_priority, _interval, callback) => timers.push(callback);
    GLib.Source.remove = source => {
        removals.push(source);
        if (source === 1)
            throw new Error('injected timer remove failure');
        return true;
    };
    try {
        scope.addTimer('timer sync test', 5, () => {
            ticks++;
            throw new Error('injected timer callback throw');
        });
        scope.addTimer('timer async test', 5, () => {
            ticks++;
            return Promise.reject(new Error('injected timer callback rejection'));
        });
        assert(timers.every(timer => timer() === GLib.SOURCE_CONTINUE), 'active timer failures must be contained');
        await Promise.resolve();
        scope.close();
        scope.close();
        assert(removals.join(',') === '1,2', 'failed timer removal must not interrupt remaining cleanup');
        assert(timers.every(timer => timer() === GLib.SOURCE_REMOVE) && ticks === 2,
            'a callback remaining after source removal failure must never access its runtime again');
    } finally {
        GLib.timeout_add_seconds = add;
        GLib.Source.remove = remove;
    }
}

async function testPopupHintIdle() {
    const oldView = new Completions();
    const newView = new Completions();
    const tick = () => new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
    let oldHints = 0;
    let newHints = 0;
    let errors = 0;
    const report = log.error;
    try {
        const focusOut = oldView.onIdle('popup focus hint', () => oldHints++);
        focusOut();
        const remove = GLib.Source.remove;
        try {
            GLib.Source.remove = () => { throw new Error('injected idle removal failure'); };
            oldView.close();
        } finally {
            GLib.Source.remove = remove;
        }
        focusOut(); // A focus-out from an actor being destroyed.
        log.error = (stage, error) => {
            if (stage === 'popup focus hint' && error?.message === 'injected hint failure')
                errors++;
            else
                report(stage, error);
        };
        const refresh = newView.onIdle('popup focus hint', () => {
            if (++newHints === 1)
                throw new Error('injected hint failure');
        });
        refresh();
        refresh();
        await tick();
        assert(oldHints === 0 && newHints === 1 && errors === 1,
            'reopening must retire old work and contain a coalesced hint failure');
        refresh();
        await tick();
        assert(newHints === 2, 'a later focus event must still refresh the visible hint');
    } finally {
        log.error = report;
        oldView.close();
        newView.close();
    }
}

function testNumberPickTimeouts() {
    const add = GLib.timeout_add;
    const remove = GLib.Source.remove;
    const timers = [];
    const picks = [];
    GLib.timeout_add = (_priority, _delay, callback) => timers.push(callback);
    GLib.Source.remove = () => { throw new Error('injected number pick removal failure'); };
    try {
        const oldView = new Completions();
        const cancel = oldView.after('number pick', 100, () => picks.push('replaced'));
        cancel();
        cancel();
        oldView.after('number pick', 100, () => picks.push('closed'));
        oldView.close();
        const newView = new Completions();
        const cancelNew = newView.after('number pick', 3000, () => picks.push('new'));
        assert(timers[0]() === GLib.SOURCE_REMOVE && timers[1]() === GLib.SOURCE_REMOVE && !picks.length,
            'neither a superseded timeout nor a closed view can activate a row');
        timers[2]();
        timers[2]();
        cancelNew();
        newView.close();
        assert(picks.join() === 'new', 'the current timeout must run exactly once');
    } finally {
        GLib.timeout_add = add;
        GLib.Source.remove = remove;
    }
}

function testViewSignals() {
    const view = new Completions();
    const original = log.error;
    const stages = [];
    let calls = 0;
    log.error = (stage, error) => {
        assert(error instanceof Error, 'signal failures must include their original exception');
        stages.push(stage);
    };
    const makeSignal = stage => view.onSignal(stage, () => {
        calls++;
        throw new Error('injected search widget failure');
    });
    try {
        const changed = makeSignal('popup search text-changed');
        const focused = makeSignal('popup search key-focus-in');
        changed();
        focused();
        view.close();
        changed();
        focused();
        assert(calls === 2 && stages.join(',') === 'popup search text-changed,popup search key-focus-in',
            'signal exceptions must be contained and retired signals must be inert');
    } finally {
        view.close();
        log.error = original;
    }
}

if (ARGV.includes('--logging-probe')) {
    loggingProbe();
} else {
    assert(Object.keys(log).sort().join(',') === 'debug,error,info,warn',
        'use only the standard log levels');
    Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
    const path = Gio.File.new_for_uri(import.meta.url).get_path();
    const probe = Gio.Subprocess.new(['gjs', '-m', path, '--logging-probe'],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    const [output] = await probe.communicate_utf8_async(null, null);
    assert(probe.get_successful(), output);
    assert(output.includes('ERROR: capture stage: injected') && output.includes('loggingProbe@'),
        'exception must log the stage and caller stack');
    assert(output.includes('ERROR: invalid thrown value: unknown error'),
        'throwing error getters must stay inside the logger');
    assert(!output.includes('filtered warning'), 'configured log level must filter warnings');
    const messages = output.split('\n').filter(line => line.includes('ERROR: bounded message'));
    assert(messages.length === 40 && output.includes('ERROR: distinct late error: preserved'),
        'repeated failures must not hide the next error');
    assert(messages.every(line => line.length < 1800), 'oversized log fields must be truncated');
    await testRetiredCompletions();
    await testRetiredTimers();
    await testPopupHintIdle();
    testViewSignals();
    testNumberPickTimeouts();
    print('logging and completion tests passed');
}
