export const UUID = "copy-gnome@clipboard";
export const GSETTINGS_SCHEMA = "org.gnome.shell.extensions.copy-gnome";
export const GSETTINGS_TOGGLE_POPUP = "toggle-popup";
// GNOME Shell majors this extension is built and tested for. First entry is the fallback
// used when the running shell's major can't be parsed.
export const SUPPORTED_GNOME_MAJORS = [46, 50];
export const MAX_SNAPSHOT_LINE_BYTES = 64 * 1024 * 1024;

export const RECOVERY_COMMANDS = [
  `gnome-extensions disable ${UUID}`,
  "journalctl --user -b 0 | rg -i 'copy-gnome|gnome-shell|signal 11|JS ERROR'",
];
