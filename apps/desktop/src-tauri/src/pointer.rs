//! Cursor companion: a small marker that follows the pointer and can carry a
//! message.
//!
//! Implemented as a tiny always-on-top window that Rust repositions on mouse
//! move, rather than a fullscreen overlay that streams coordinates into a
//! webview. A fullscreen transparent window would have to be click-through to
//! avoid swallowing every click on the machine, and would still repaint across
//! the whole screen; moving a ~260x64 window costs one `setFrameOrigin` per
//! event and paints nothing extra.
//!
//! The window is click-through regardless (`ignoresMouseEvents`), because it
//! sits directly under the pointer and must never intercept what the user is
//! actually clicking on.
//!
//! Global mouse monitoring needs no Accessibility grant — only keyboard
//! monitoring does — so this works without any permission prompt.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Size of the companion window. The marker draws in the top-left corner and
/// the message extends right, so the window is wider than it looks.
const WIDTH: f64 = 260.0;
const HEIGHT: f64 = 64.0;
/// Offset from the hotspot so the marker sits beside the arrow, not under it.
const OFFSET_X: f64 = 14.0;
const OFFSET_Y: f64 = 10.0;

#[derive(Clone, Serialize)]
pub struct PointerMessage {
    pub text: String,
    /// Milliseconds to stay on screen; the page clears itself after this.
    pub ttl_ms: u64,
}

#[derive(Default)]
pub struct PointerState {
    monitor: Mutex<Option<MonitorHandle>>,
}

/// Keeps the global event monitor alive; dropping it removes the monitor.
pub struct MonitorHandle(#[allow(dead_code)] Arc<()>);

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSEvent, NSEventMask, NSScreen, NSWindow};
    use objc2_foundation::{MainThreadMarker, NSPoint};

    /// Above normal windows but below the HUD, so the companion never covers
    /// the panel the user is reading.
    const FLOATING_WINDOW_LEVEL: isize = 24;

    pub fn configure(ns_window: *mut std::ffi::c_void) {
        if ns_window.is_null() {
            return;
        }
        let window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        window.setLevel(FLOATING_WINDOW_LEVEL);
        window.setOpaque(false);
        window.setHasShadow(false);
        window.setIgnoresMouseEvents(true);
        window.setHidesOnDeactivate(false);
    }

    pub fn mouse_location() -> (f64, f64) {
        let point: NSPoint = NSEvent::mouseLocation();
        (point.x, point.y)
    }

    /// Converts an AppKit bottom-left Y into the top-left space Tauri uses.
    pub fn flip_y(y: f64) -> f64 {
        let Some(mtm) = MainThreadMarker::new() else {
            return y;
        };
        let top = NSScreen::screens(mtm)
            .iter()
            .map(|screen| screen.frame().origin.y + screen.frame().size.height)
            .fold(0.0_f64, f64::max);
        top - y
    }

    /// Installs a global mouse-move monitor, returning a token that removes it
    /// when dropped.
    pub fn watch_mouse<F: Fn(f64, f64) + Clone + 'static>(
        handler: F,
    ) -> Option<Retained<objc2::runtime::AnyObject>> {
        let _ = MainThreadMarker::new()?;
        let local_handler = handler.clone();
        let block = block2::RcBlock::new(move |event: core::ptr::NonNull<NSEvent>| {
            let _ = event;
            let (x, y) = mouse_location();
            handler(x, y);
        });
        // A *global* monitor only sees events destined for other applications,
        // so without a local one too the companion freezes the moment the
        // pointer crosses one of our own windows — which is most of the time
        // while the HUD is open.
        let local = block2::RcBlock::new(
            move |event: core::ptr::NonNull<NSEvent>| -> *mut NSEvent {
                let (x, y) = mouse_location();
                local_handler(x, y);
                // Pass the event through untouched; swallowing it here would
                // eat mouse movement inside our own windows.
                event.as_ptr()
            },
        );
        let _local_token = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::MouseMoved | NSEventMask::LeftMouseDragged,
                &local,
            )
        };
        std::mem::forget(_local_token);

        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::MouseMoved | NSEventMask::LeftMouseDragged,
            &block,
        )
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn configure(_ns_window: *mut std::ffi::c_void) {}
    pub fn mouse_location() -> (f64, f64) {
        (0.0, 0.0)
    }
}

fn ns_window_of(window: &WebviewWindow) -> *mut std::ffi::c_void {
    window
        .ns_window()
        .unwrap_or(std::ptr::null_mut::<std::ffi::c_void>())
}

/// Builds the companion window, hidden. Like the HUD it points at the local
/// Studio server, so it must not be created before that server is listening.
pub fn create(app: &AppHandle) -> Result<WebviewWindow, tauri::Error> {
    if let Some(existing) = app.get_webview_window("pointer") {
        return Ok(existing);
    }
    let url = "http://127.0.0.1:31420/pointer"
        .parse()
        .map_err(|_| tauri::Error::UnknownPath)?;
    let window = WebviewWindowBuilder::new(app, "pointer", WebviewUrl::External(url))
        .title("Context Layer Pointer")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .visible_on_all_workspaces(true)
        .build()?;
    platform::configure(ns_window_of(&window));
    let _ = window.set_ignore_cursor_events(true);
    Ok(window)
}

/// Moves the companion to the pointer.
///
/// Two conversions, and getting either wrong parks the window somewhere
/// arbitrary. `NSEvent::mouseLocation` reports **logical points** with a
/// **bottom-left** origin; Tauri positions windows in **top-left** space, and
/// `PhysicalPosition` would additionally double every value on a 2x display.
/// So: flip Y against the tallest screen edge, and pass logical units.
fn follow(window: &WebviewWindow, x: f64, y: f64) {
    let top_left_y = platform::flip_y(y);
    let _ = window.set_position(tauri::LogicalPosition::new(
        x + OFFSET_X,
        top_left_y + OFFSET_Y,
    ));
}

/// Shows the companion with a message and starts following the pointer.
pub fn show(app: &AppHandle, message: PointerMessage) -> Result<(), tauri::Error> {
    let window = create(app)?;
    let (x, y) = platform::mouse_location();
    follow(&window, x, y);
    let _ = window.emit("pointer://message", message);
    let _ = window.show();

    #[cfg(target_os = "macos")]
    {
        let state = app.state::<PointerState>();
        let mut monitor = state.monitor.lock().map_err(|_| tauri::Error::UnknownPath)?;
        if monitor.is_none() {
            let follower = window.clone();
            let token = platform::watch_mouse(move |x, y| follow(&follower, x, y));
            if token.is_some() {
                // Leaking the token deliberately: the monitor lives as long as
                // the app, and the companion is shown and hidden repeatedly.
                std::mem::forget(token);
                *monitor = Some(MonitorHandle(Arc::new(())));
            }
        }
    }
    Ok(())
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("pointer") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn pointer_show(app: AppHandle, text: String, ttl_ms: Option<u64>) {
    let _ = show(
        &app,
        PointerMessage {
            text,
            ttl_ms: ttl_ms.unwrap_or(4_000),
        },
    );
}

#[tauri::command]
pub fn pointer_hide(app: AppHandle) {
    hide(&app);
}
