# copy-gnome

## GNOME Shell Extension Constraints

1. **Prevent exceptions from propagating into GNOME Shell.** Catch exceptions at the entry points of signal handlers, timer callbacks, Promise handlers, and D-Bus callbacks. Log the stage at which each failure occurred.
2. **Use only independent copies in asynchronous code.** Copy all required data before starting asynchronous work. Asynchronous code must never retain or access the original Shell objects, references, or callback context. If the required data cannot be copied in full, skip that asynchronous path.
3. **Prevent GNOME Shell from hanging.** Avoid synchronous I/O, synchronous D-Bus calls, and long-running computations on the main thread. Set separate timeouts for establishing connections and completing requests. Support cancellation for both.
4. **Prevent re-entry into fallback paths.** If a fallback fails, exit the current execution path. Set limits on retries, log volume, and the amount of work per operation. Reduce extension functionality when necessary.
5. **Prevent access to resources after destruction.** When disabling the extension, invalidate callbacks first. Then disconnect signals, remove timers, cancel asynchronous requests, and destroy UI components. Cleanup must be safe to repeat. If a cleanup step fails, continue cleaning up the remaining resources.
6. **Log extensively throughout the extension.** Choose the log level based on the event. At a minimum, use `DEBUG` for the start and end of operations, `INFO` for extension startup, shutdown, and connections, `WARN` for timeouts and degraded functionality, and `ERROR` for failures. Include a stack trace in each `ERROR` entry.
