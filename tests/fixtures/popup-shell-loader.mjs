// Exercise the real Popup class without starting a compositor or taking a modal grab.
export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'gi://Clutter') {
        const constants = { EVENT_STOP: true, EVENT_PROPAGATE: false, KEY_s: 115, BUTTON_PRIMARY: 1, BUTTON_SECONDARY: 3 };
        return { url: `data:text/javascript,export default ${JSON.stringify(constants)}`, shortCircuit: true };
    }
    if (specifier === 'gi://GObject')
        return { url: 'data:text/javascript,export default {registerClass: c => c}', shortCircuit: true };
    if (specifier.startsWith('gi://'))
        return { url: 'data:text/javascript,export default {}', shortCircuit: true };
    if (specifier === 'resource:///org/gnome/shell/ui/main.js')
        return { url: 'data:text/javascript,export function popModal(grab) { grab.release(); }', shortCircuit: true };
    if (specifier === 'resource:///org/gnome/shell/ui/panelMenu.js')
        return { url: 'data:text/javascript,export class Button {}', shortCircuit: true };
    if (specifier === 'resource:///org/gnome/shell/ui/popupMenu.js')
        return { url: 'data:text/javascript,export class PopupMenuItem {}', shortCircuit: true };
    const result = await nextResolve(specifier, context);
    if (/\/copy-gnome-(46|50)\//.test(result.url))
        return { ...result, format: 'module' };
    return result;
}
