/**
 * Follows a drag that started with `event` (pointerdown, primary button) on `handle` until the button is
 * released: `move` gets every pointer move, `end` is called once.
 *
 * Robust in every host of the web app (browsers, Electron, the VS Code webview, the Eclipse SWT browser,
 * JCEF of the JetBrains IDEs with off-screen rendering): the pointer is captured, but the moves are taken
 * from the window, so the drag also works where the capture fails; the moves do not depend on `buttons`
 * (off-screen browsers do not always report it). The drag ends on pointerup, pointercancel, the loss of the
 * capture and when the window loses the focus.
 */
export function trackPointerDrag(handle: HTMLElement, event: PointerEvent, move: (e: PointerEvent) => void, end: () => void): void {
    const pointerId = event.pointerId;
    try {
        handle.setPointerCapture(pointerId);
    } catch {
        // no capture (e.g. synthetic events): the listeners of the window follow the pointer
    }
    let done = false;
    const onMove = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) {
            return;
        }
        move(e);
    };
    const onUp = (e: PointerEvent) => {
        if (e.pointerId === pointerId) {
            finish();
        }
    };
    const finish = () => {
        if (done) {
            return;
        }
        done = true;
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        window.removeEventListener('blur', finish);
        handle.removeEventListener('lostpointercapture', finish);
        try {
            if (handle.hasPointerCapture(pointerId)) {
                handle.releasePointerCapture(pointerId);
            }
        } catch {
            // already released
        }
        end();
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('blur', finish);
    handle.addEventListener('lostpointercapture', finish);
}
