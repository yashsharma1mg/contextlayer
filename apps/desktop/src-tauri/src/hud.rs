//! Notch-anchored HUD window.
//!
//! The HUD is a borderless, transparent, always-on-top window pinned to the
//! MacBook notch, falling back to the top-left corner on displays that have
//! none. It has two sizes: a collapsed bar the width of the notch, and an
//! expanded panel that grows downward from the same pinned top edge.
//!
//! Two deliberate choices, both cheaper than the AppKit-native equivalents:
//!
//! * Hover is detected in the webview as an ordinary DOM `mouseenter` and sent
//!   here over IPC, so there is no `NSTrackingArea` and no cursor-rect
//!   bookkeeping.
//! * The frame is resized instantly rather than animated. The window is
//!   transparent, so only painted pixels read as motion — CSS animates the
//!   content and the frame change underneath it is invisible. That avoids
//!   `NSAnimationContext` frame animation entirely.
//!
//! This is a plain `NSWindow`, not an `NSPanel`. Hover never calls `set_focus`,
//! so it never activates the app; the hotkey path does, because typing needs
//! key status. If a future state needs clicks that do *not* activate, that is
//! the point at which this would have to become a non-activating `NSPanel`.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WebviewWindow};

/// Collapsed height.
///
/// The notch itself is ~32pt, and anything drawn inside that band sits behind
/// the physical camera housing where nobody can read it. This leaves a usable
/// strip below the cutout for the one thing the collapsed state shows — the
/// status dot — without becoming a black tab hanging off the top of the screen.
const COLLAPSED_HEIGHT: f64 = 46.0;
/// Collapsed width used when the display has no notch to match.
const FALLBACK_COLLAPSED_WIDTH: f64 = 220.0;
/// Inset from the screen edge in the no-notch fallback.
const FALLBACK_MARGIN: f64 = 12.0;

const EXPANDED_WIDTH: f64 = 640.0;
const EXPANDED_HEIGHT: f64 = 300.0;

/// Geometry for one screen, in AppKit coordinates (origin bottom-left).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HudFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A rectangle, matching NSRect's origin-bottom-left convention.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Collapsed and expanded frames for one screen.
///
/// Split out from the AppKit calls so the anchoring and clamping can be tested
/// against synthetic displays — this is where the bugs live, not in the
/// NSScreen lookups.
///
/// `notch` is the cutout as (origin_x, width) when the display has one. Both
/// returned frames share a top edge: expanding grows downward and never moves
/// the anchor, which is what lets the panel animate purely in CSS.
pub fn compute_frames(
    screen: Rect,
    visible: Rect,
    notch: Option<(f64, f64)>,
) -> (HudFrame, HudFrame) {
    let (collapsed_x, collapsed_width, top) = match notch {
        // Pin to the cutout, flush with the physical top of the display.
        Some((x, width)) => (x, width, screen.y + screen.height),
        // No notch: sit just under the menu bar at the left edge. visibleFrame
        // already excludes the menu bar, so its top is the first usable row.
        None => (
            visible.x + FALLBACK_MARGIN,
            FALLBACK_COLLAPSED_WIDTH,
            visible.y + visible.height,
        ),
    };

    let collapsed = HudFrame {
        x: collapsed_x,
        y: top - COLLAPSED_HEIGHT,
        width: collapsed_width,
        height: COLLAPSED_HEIGHT,
    };

    // Centre the expanded panel on the collapsed one, then keep it on screen:
    // a notch on a narrow display would otherwise push it past the edge.
    let desired_x = collapsed_x + (collapsed_width / 2.0) - (EXPANDED_WIDTH / 2.0);
    let max_x = visible.x + visible.width - EXPANDED_WIDTH;
    let expanded = HudFrame {
        x: desired_x.clamp(visible.x, max_x.max(visible.x)),
        y: top - EXPANDED_HEIGHT,
        width: EXPANDED_WIDTH,
        height: EXPANDED_HEIGHT,
    };

    (collapsed, expanded)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{compute_frames, HudFrame, Rect};
    use objc2::rc::Retained;
    use objc2_app_kit::{
        NSEvent, NSScreen, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};

    /// Above the menu bar so the HUD can overlap the notch, but below
    /// `NSScreenSaverWindowLevel` so genuine system alerts still win.
    const STATUS_WINDOW_LEVEL: isize = 25;

    /// The screen the pointer is on, falling back to the main screen. A single
    /// HUD follows the mouse rather than one window per display — that pattern
    /// exists for overlays that must cover every screen at once, which this is
    /// not.
    fn active_screen(mtm: MainThreadMarker) -> Option<Retained<NSScreen>> {
        let mouse = NSEvent::mouseLocation();
        let screens = NSScreen::screens(mtm);
        for screen in screens.iter() {
            let frame = screen.frame();
            if mouse.x >= frame.origin.x
                && mouse.x <= frame.origin.x + frame.size.width
                && mouse.y >= frame.origin.y
                && mouse.y <= frame.origin.y + frame.size.height
            {
                return Some(screen);
            }
        }
        NSScreen::mainScreen(mtm)
    }

    /// Notch bounds if this screen has one.
    ///
    /// `auxiliaryTopLeftArea` and `auxiliaryTopRightArea` are the usable menu
    /// bar regions either side of the cutout, so the gap between them is the
    /// notch. Both are null on screens without one, and `safeAreaInsets.top` is
    /// zero there, which is the cheaper test.
    fn notch_bounds(screen: &NSScreen) -> Option<(f64, f64)> {
        let inset_top = screen.safeAreaInsets().top;
        if inset_top <= 0.0 {
            return None;
        }
        // Declared non-null, so these come back as NSZeroRect rather than None
        // on a screen with no cutout; safeAreaInsets above is the real test.
        let left = screen.auxiliaryTopLeftArea();
        let right = screen.auxiliaryTopRightArea();
        if left.size.width <= 0.0 || right.size.width <= 0.0 {
            return None;
        }
        let frame = screen.frame();
        let width = frame.size.width - left.size.width - right.size.width;
        if width <= 0.0 {
            return None;
        }
        Some((frame.origin.x + left.size.width, width))
    }

    fn to_rect(rect: NSRect) -> Rect {
        Rect {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        }
    }

    /// Reads the active screen and hands the numbers to `compute_frames`.
    pub fn frames() -> Option<(HudFrame, HudFrame)> {
        let mtm = MainThreadMarker::new()?;
        let screen = active_screen(mtm)?;
        Some(compute_frames(
            to_rect(screen.frame()),
            to_rect(screen.visibleFrame()),
            notch_bounds(&screen),
        ))
    }

    /// Applies the window flags Tauri does not expose.
    ///
    /// `canJoinAllSpaces` plus `stationary` keeps the HUD present when the user
    /// switches Space without it sliding in the transition, and
    /// `fullScreenAuxiliary` lets it draw over a fullscreen app instead of
    /// being hidden behind one.
    pub fn configure(ns_window: *mut std::ffi::c_void) {
        if ns_window.is_null() {
            return;
        }
        let window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        window.setLevel(STATUS_WINDOW_LEVEL);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
        window.setStyleMask(NSWindowStyleMask::Borderless);
        window.setOpaque(false);
        window.setHasShadow(false);
        // Survives the app losing focus — the HUD is ambient, not a dialog.
        window.setHidesOnDeactivate(false);
        window.setMovableByWindowBackground(false);
    }

    pub fn set_frame(ns_window: *mut std::ffi::c_void, frame: HudFrame) {
        if ns_window.is_null() {
            return;
        }
        let window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        let rect = NSRect::new(
            NSPoint::new(frame.x, frame.y),
            NSSize::new(frame.width, frame.height),
        );
        // display:true, animate:false — see the module note on why the frame
        // change is deliberately not animated.
        window.setFrame_display_animate(rect, true, false);
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::HudFrame;
    pub fn frames() -> Option<(HudFrame, HudFrame)> {
        None
    }
    pub fn configure(_ns_window: *mut std::ffi::c_void) {}
    pub fn set_frame(_ns_window: *mut std::ffi::c_void, _frame: HudFrame) {}
}

fn ns_window_of(window: &WebviewWindow) -> *mut std::ffi::c_void {
    window
        .ns_window()
        .unwrap_or(std::ptr::null_mut::<std::ffi::c_void>())
}

/// Builds the HUD window and parks it at its collapsed size.
///
/// Deliberately not declared in tauri.conf.json: the page is served by the
/// local Studio process, so a window created at app start would load before
/// that server is listening, fail with a refused connection, and never retry.
/// The caller invokes this only after the port is confirmed up.
pub fn create(app: &AppHandle) -> Result<WebviewWindow, tauri::Error> {
    if let Some(existing) = app.get_webview_window("hud") {
        return Ok(existing);
    }
    let url = "http://127.0.0.1:31420/hud"
        .parse()
        .map_err(|_| tauri::Error::UnknownPath)?;
    let window = WebviewWindowBuilder::new(app, "hud", WebviewUrl::External(url))
        .title("Context Layer HUD")
        .inner_size(FALLBACK_COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        // Never take focus on creation: the HUD is ambient, and stealing key
        // status from whatever the user is working in is the one thing it
        // must not do.
        .focused(false)
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true)
        // Off until the canvas asks for it. Created up front regardless so the
        // page is already loaded and the first reveal is instant rather than a
        // blank window that fills in.
        .visible(false)
        .build()?;
    init(&window);
    Ok(window)
}

/// Applies platform flags and parks the HUD at its collapsed size.
pub fn init(window: &WebviewWindow) {
    let handle = ns_window_of(window);
    platform::configure(handle);
    collapse(window);
}

pub fn collapse(window: &WebviewWindow) {
    if let Some((collapsed, _)) = platform::frames() {
        platform::set_frame(ns_window_of(window), collapsed);
    }
}

pub fn expand(window: &WebviewWindow) {
    if let Some((_, expanded)) = platform::frames() {
        platform::set_frame(ns_window_of(window), expanded);
    }
}

/// Shrinks the expanded frame to the height the page actually renders.
///
/// The panel is content-sized, so a fixed expanded height leaves a tall
/// transparent strip beneath it. That strip is invisible but still swallows
/// mouse events, so clicks meant for the app underneath would hit the HUD
/// instead. The page measures itself and calls this.
pub fn set_content_height(window: &WebviewWindow, height: f64) {
    if let Some((_, expanded)) = platform::frames() {
        // A bad measurement must not produce a zero-height or
        // screen-swallowing window.
        let height = height.clamp(COLLAPSED_HEIGHT, expanded.height);
        platform::set_frame(
            ns_window_of(window),
            HudFrame {
                // Keep the pinned top edge; only the bottom moves.
                y: expanded.y + expanded.height - height,
                height,
                ..expanded
            },
        );
    }
}

/// Grow, show, and take keyboard focus. Only the hotkey path calls this —
/// hover must never activate the app.
pub fn focus(window: &WebviewWindow) {
    expand(window);
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 14" MacBook Pro at default scaling: 1512x982, 32pt menu bar, ~200pt notch.
    fn macbook() -> (Rect, Rect) {
        (
            Rect { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 },
            Rect { x: 0.0, y: 0.0, width: 1512.0, height: 950.0 },
        )
    }

    #[test]
    fn notched_screen_pins_the_bar_to_the_cutout() {
        let (screen, visible) = macbook();
        let notch = Some((656.0, 200.0));
        let (collapsed, _) = compute_frames(screen, visible, notch);

        // Exactly the cutout's horizontal span.
        assert_eq!(collapsed.x, 656.0);
        assert_eq!(collapsed.width, 200.0);
        // Flush with the physical top, not the menu bar's bottom.
        assert_eq!(collapsed.y + collapsed.height, 982.0);
    }

    #[test]
    fn expanding_grows_downward_from_the_same_top_edge() {
        let (screen, visible) = macbook();
        let (collapsed, expanded) = compute_frames(screen, visible, Some((656.0, 200.0)));

        // The shared top edge is what lets the panel animate purely in CSS; if
        // these diverge the window visibly jumps when it expands.
        assert_eq!(collapsed.y + collapsed.height, expanded.y + expanded.height);
        assert!(expanded.height > collapsed.height);
    }

    #[test]
    fn expanded_panel_is_centred_on_the_notch() {
        let (screen, visible) = macbook();
        let (collapsed, expanded) = compute_frames(screen, visible, Some((656.0, 200.0)));

        let notch_centre = collapsed.x + collapsed.width / 2.0;
        let panel_centre = expanded.x + expanded.width / 2.0;
        assert!((notch_centre - panel_centre).abs() < 0.001);
    }

    #[test]
    fn screens_without_a_notch_fall_back_below_the_menu_bar() {
        let (screen, visible) = macbook();
        let (collapsed, _) = compute_frames(screen, visible, None);

        // This is the state visible in an external-display screenshot: flush
        // left, and below the menu bar rather than flush with the screen top.
        assert_eq!(collapsed.x, visible.x + FALLBACK_MARGIN);
        assert_eq!(collapsed.width, FALLBACK_COLLAPSED_WIDTH);
        assert_eq!(collapsed.y + collapsed.height, visible.y + visible.height);
        assert!(collapsed.y + collapsed.height < screen.y + screen.height);
    }

    /// Values read off the machine this was built on (MacBook Air 13", built-in
    /// Liquid Retina). Synthetic screens verify the shape of the maths; this
    /// pins it to hardware that actually exists, where the notch is not
    /// centred to the pixel — auxiliaryTopLeftArea is 646 and the right is 645.
    #[test]
    fn matches_real_hardware() {
        let screen = Rect { x: 0.0, y: 0.0, width: 1470.0, height: 956.0 };
        let visible = Rect { x: 0.0, y: 57.0, width: 1470.0, height: 866.0 };
        // frame.width - auxLeft(646) - auxRight(645) = 179, starting at 646.
        let (collapsed, expanded) = compute_frames(screen, visible, Some((646.0, 179.0)));

        assert_eq!(collapsed.x, 646.0);
        assert_eq!(collapsed.width, 179.0);
        // Flush with the physical top (956), not the menu bar bottom (923).
        assert_eq!(collapsed.y + collapsed.height, 956.0);

        // Centred on the real notch, and comfortably on screen.
        assert_eq!(expanded.x, 646.0 + 89.5 - 320.0);
        assert_eq!(expanded.y + expanded.height, 956.0);
        assert!(expanded.x >= 0.0 && expanded.x + expanded.width <= 1470.0);
    }

    #[test]
    fn expanded_panel_is_clamped_onto_a_narrow_screen() {
        // Narrower than the expanded panel's preferred 640, with the notch far
        // right. Centring alone would push the panel off both edges.
        let screen = Rect { x: 0.0, y: 0.0, width: 800.0, height: 600.0 };
        let visible = Rect { x: 0.0, y: 0.0, width: 800.0, height: 570.0 };
        let (_, expanded) = compute_frames(screen, visible, Some((700.0, 60.0)));

        assert!(expanded.x >= visible.x);
        assert!(expanded.x + expanded.width <= visible.x + visible.width + 0.001);
    }

    #[test]
    fn geometry_is_relative_to_the_screen_not_the_global_origin() {
        // A second display sitting to the right of the built-in one. Using raw
        // widths instead of the screen's own origin would land the HUD on the
        // wrong monitor.
        let screen = Rect { x: 1512.0, y: 0.0, width: 1920.0, height: 1080.0 };
        let visible = Rect { x: 1512.0, y: 0.0, width: 1920.0, height: 1055.0 };
        let (collapsed, expanded) = compute_frames(screen, visible, None);

        assert_eq!(collapsed.x, 1512.0 + FALLBACK_MARGIN);
        assert!(expanded.x >= 1512.0);
        assert!(expanded.x + expanded.width <= 1512.0 + 1920.0 + 0.001);
    }
}

/// Whether the HUD is currently on screen. Drives the canvas toggle's state.
#[tauri::command]
pub fn hud_visible(app: AppHandle) -> bool {
    app.get_webview_window("hud")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// Shows or hides the HUD. Returns the resulting state so the caller does not
/// have to ask again.
///
/// Showing uses `show` without `set_focus`: revealing the HUD must not pull
/// focus away from the canvas the user just clicked in.
#[tauri::command]
pub fn hud_set_visible(app: AppHandle, visible: bool) -> bool {
    let Some(window) = app.get_webview_window("hud") else {
        return false;
    };
    if visible {
        collapse(&window);
        let _ = window.show();
    } else {
        let _ = window.hide();
    }
    visible
}

#[tauri::command]
pub fn hud_expand(window: WebviewWindow) {
    expand(&window);
}

#[tauri::command]
pub fn hud_content_height(window: WebviewWindow, height: f64) {
	set_content_height(&window, height);
}

#[tauri::command]
pub fn hud_collapse(window: WebviewWindow) {
    collapse(&window);
}

/// Called when the HUD is dismissed: shrink back to ambient and hand key
/// status back to whatever the user was actually working in. Hiding the app is
/// what returns focus to the previous one; the HUD window itself stays
/// visible because it is ambient, not a dialog.
#[tauri::command]
pub fn hud_dismiss(window: WebviewWindow) {
    collapse(&window);
    #[cfg(target_os = "macos")]
    {
        let _ = window.app_handle().hide();
    }
}
