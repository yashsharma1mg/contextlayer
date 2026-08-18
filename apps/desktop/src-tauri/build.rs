fn main() {
    // App commands are not in the ACL by default, so a window showing a remote
    // origin — which both of ours do, since the UI is served by the bundled
    // Studio process — has every invoke rejected with "not allowed by ACL".
    // Declaring them here generates the `allow-*` permissions the capabilities
    // reference.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "hud_visible",
                "hud_set_visible",
                "hud_expand",
                "hud_content_height",
                "hud_collapse",
                "hud_dismiss",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
