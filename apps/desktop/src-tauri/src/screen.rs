//! Screen awareness: capture, and reading what sits under the pointer.
//!
//! Both go through the `screen-agent` sidecar rather than linking
//! ScreenCaptureKit and the Accessibility API into the shell. Each is TCC-gated
//! and can be revoked at any time, so running them out of process means a
//! refusal fails one call instead of taking the app down, and the grant prompt
//! is attributed to the bundle exactly as it is for media extraction.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize)]
pub struct Permissions {
    pub accessibility: bool,
    #[serde(rename = "screenRecording")]
    pub screen_recording: bool,
}

#[derive(Serialize, Deserialize)]
pub struct Capture {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize)]
pub struct Element {
    pub text: String,
    pub attribute: String,
    pub role: String,
}

fn sidecar() -> Result<PathBuf, String> {
    Ok(std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or("Desktop binary has no parent directory")?
        .join("screen-agent"))
}

/// Runs the sidecar and parses its JSON. Errors come back on stderr as JSON
/// too, but the message is what matters to the caller, so it is surfaced raw.
fn run<T: for<'de> Deserialize<'de>>(args: &[&str]) -> Result<T, String> {
    let output = Command::new(sidecar()?)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(
            serde_json::from_str::<serde_json::Value>(&message)
                .ok()
                .and_then(|value| {
                    value.get("error").and_then(|e| e.as_str()).map(str::to_string)
                })
                .unwrap_or_else(|| message.trim().to_string()),
        );
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

/// Which grants are held right now. Never prompts, so the UI can explain what
/// is missing before the user triggers something that would silently fail.
#[tauri::command]
pub fn screen_permissions() -> Result<Permissions, String> {
    run(&["permissions"])
}

/// Captures the screen into the app's data directory and returns the path.
///
/// Written to disk rather than returned as base64: a retina display is several
/// megabytes, and the agent reads it from disk anyway when handing it to a
/// vision model.
#[tauri::command]
pub fn screen_capture(app: AppHandle) -> Result<Capture, String> {
    // The same directory the rest of the runtime uses, not Tauri's
    // identifier-based app_data_dir: the agent is a separate process and looks
    // for captures relative to CONTEXT_LAYER_DATA_DIR.
    let directory = std::env::var_os("CONTEXT_LAYER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(
            app.path()
                .home_dir()
                .map_err(|error| error.to_string())?
                .join("Library")
                .join("Application Support")
                .join("Context Layer"),
        )
        .join("captures");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!(
        "screen-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis()
    ));
    run(&["capture", &path.to_string_lossy()])
}

/// Reads the accessible text at a screen point — the "click anything and copy
/// it" primitive.
#[tauri::command]
pub fn screen_element(x: f64, y: f64) -> Result<Element, String> {
    run(&["element", &x.to_string(), &y.to_string()])
}

/// Copy mode: the next click anywhere on screen copies whatever is under it.
///
/// A one-shot global monitor rather than a persistent one — the mode ends on
/// the first click, so there is no lingering machine-wide click observer.
/// Global mouse monitors are passive: the click still reaches the app the user
/// aimed at, so this reads what they clicked rather than intercepting it.
#[cfg(target_os = "macos")]
pub fn start_copy_mode(app: &AppHandle) {
    use objc2_app_kit::{NSEvent, NSEventMask, NSPasteboard, NSPasteboardTypeString, NSScreen};
    use objc2_foundation::{MainThreadMarker, NSString};

    let handle = app.clone();
    let block = block2::RcBlock::new(move |_event: core::ptr::NonNull<NSEvent>| {
        let point = NSEvent::mouseLocation();
        // AppKit reports a bottom-left origin; the Accessibility API expects
        // top-left. Flip against the primary screen, which is what defines the
        // global coordinate space.
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let height = NSScreen::screens(mtm)
            .iter()
            .map(|screen| screen.frame().origin.y + screen.frame().size.height)
            .fold(0.0_f64, f64::max);
        let flipped = height - point.y;

        let (text, message) = match screen_element(point.x, flipped) {
            Ok(element) if !element.text.trim().is_empty() => {
                let preview: String = element.text.chars().take(48).collect();
                (Some(element.text), format!("Copied “{preview}”"))
            }
            Ok(_) => (None, "Nothing readable there".to_string()),
            Err(error) => (None, error),
        };

        if let Some(text) = text {
            let pasteboard = NSPasteboard::generalPasteboard();
            unsafe {
                pasteboard.clearContents();
                pasteboard.setString_forType(&NSString::from_str(&text), NSPasteboardTypeString);
            }
        }
        let _ = crate::pointer::show(
            &handle,
            crate::pointer::PointerMessage {
                text: message,
                ttl_ms: 2_600,
            },
        );
    });

    let token =
        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(NSEventMask::LeftMouseDown, &block);
    // Held for the life of the app: AppKit gives no way to remove a monitor
    // from inside its own handler, and one passive click observer is cheap.
    std::mem::forget(token);
}

#[cfg(not(target_os = "macos"))]
pub fn start_copy_mode(_app: &AppHandle) {}

/// Arms copy mode and tells the user what to do, since the only visible change
/// is the companion following the cursor.
#[tauri::command]
pub fn screen_copy_mode(app: AppHandle) {
    let _ = crate::pointer::show(
        &app,
        crate::pointer::PointerMessage {
            text: "Click anything to copy it".to_string(),
            ttl_ms: 6_000,
        },
    );
    start_copy_mode(&app);
}
