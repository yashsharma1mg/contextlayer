import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

/// Screen awareness for the HUD, as a sidecar rather than in-process.
///
/// Both capabilities here are TCC-gated and each prompts the user the first
/// time it is used: capture needs Screen Recording, reading an element needs
/// Accessibility. Keeping them in a separate short-lived process means a denied
/// or revoked grant fails one command instead of wedging the app, and matches
/// how media extraction already works.
///
/// Commands:
///   capture <output.png> [--display N]   full-screen image
///   element <x> <y>                      accessibility text under a point
///   permissions                          which grants are currently held
@main
struct ScreenAgent {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else {
            fail("Usage: screen-agent capture|element|permissions …")
        }
        switch command {
        case "capture": await capture(Array(args.dropFirst()))
        case "element": element(Array(args.dropFirst()))
        case "permissions": permissions()
        default: fail("Unknown command \(command)")
        }
    }

    // MARK: capture

    static func capture(_ args: [String]) async {
        guard let output = args.first else { fail("Usage: capture <output.png>") }
        var displayIndex = 0
        if let flag = args.firstIndex(of: "--display"), flag + 1 < args.count {
            displayIndex = Int(args[flag + 1]) ?? 0
        }

        // SCShareableContent is what triggers and reports the Screen Recording
        // grant. Asking through it gives a real error rather than the silently
        // black image the older CoreGraphics path returns when denied.
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
        } catch {
            fail("Screen Recording permission is not granted: \(error.localizedDescription)")
        }
        guard displayIndex < content.displays.count else {
            fail("No display at index \(displayIndex)")
        }
        let display = content.displays[displayIndex]

        let configuration = SCStreamConfiguration()
        configuration.width = display.width
        configuration.height = display.height
        // Excluding our own windows keeps the HUD and the cursor companion out
        // of the frame the model is asked to reason about.
        let ownWindows = content.windows.filter {
            $0.owningApplication?.bundleIdentifier == Bundle.main.bundleIdentifier
        }
        let filter = SCContentFilter(display: display, excludingWindows: ownWindows)

        do {
            let image: CGImage
            if #available(macOS 14.0, *) {
                image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter, configuration: configuration)
            } else {
                // The bundle still targets macOS 13, where SCScreenshotManager
                // does not exist. CGDisplayCreateImage is deprecated but works,
                // and the SCShareableContent call above has already established
                // that the grant is in place.
                guard let fallback = CGDisplayCreateImage(display.displayID) else {
                    fail("Capture failed on this macOS version")
                }
                image = fallback
            }
            let bitmap = NSBitmapImageRep(cgImage: image)
            guard let png = bitmap.representation(using: .png, properties: [:]) else {
                fail("Could not encode the capture as PNG")
            }
            try png.write(to: URL(fileURLWithPath: output))
            emit([
                "path": output,
                "width": image.width,
                "height": image.height,
                "display": displayIndex,
            ])
        } catch {
            fail("Capture failed: \(error.localizedDescription)")
        }
    }

    // MARK: element

    /// Reads the accessibility element under a screen point.
    ///
    /// Attribute order matters: value first because that is the actual content
    /// of a field or label, then title, then the description a control falls
    /// back on. Returning the first non-empty one is what makes "click anything
    /// and copy it" land on the text a person would have selected.
    static func element(_ args: [String]) {
        guard args.count >= 2, let x = Float(args[0]), let y = Float(args[1]) else {
            fail("Usage: element <x> <y>")
        }
        guard AXIsProcessTrusted() else {
            fail("Accessibility permission is not granted")
        }
        let system = AXUIElementCreateSystemWide()
        var target: AXUIElement?
        let status = AXUIElementCopyElementAtPosition(system, x, y, &target)
        guard status == .success, let target else {
            fail("No accessible element at \(x), \(y)")
        }

        let attributes = [
            kAXValueAttribute,
            kAXTitleAttribute,
            kAXDescriptionAttribute,
            kAXHelpAttribute,
        ]
        var text: String?
        var source: String?
        for attribute in attributes {
            var raw: CFTypeRef?
            guard
                AXUIElementCopyAttributeValue(target, attribute as CFString, &raw) == .success,
                let value = raw as? String,
                !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { continue }
            text = value
            source = attribute
            break
        }

        var roleRaw: CFTypeRef?
        AXUIElementCopyAttributeValue(target, kAXRoleAttribute as CFString, &roleRaw)

        // Canvas-drawn interfaces — editors, Figma, anything rendering its own
        // text — expose an AXGroup with no value at all. Accessibility simply
        // has nothing to give, so read the pixels instead. Without this,
        // "click anything" fails precisely where it is most wanted.
        if text == nil, let recognized = textByReading(around: CGPoint(x: Double(x), y: Double(y))) {
            text = recognized
            source = "ocr"
        }

        emit([
            "text": text ?? "",
            "attribute": source ?? "",
            "role": (roleRaw as? String) ?? "",
            "x": x,
            "y": y,
        ])
    }

    /// Reads text from the pixels around a point.
    ///
    /// The window is deliberately wide and short: a click lands on a line of
    /// text, and a tall crop would pull in neighbouring lines that the user did
    /// not point at. Of the lines found, the one whose centre is nearest the
    /// click wins.
    static func textByReading(around point: CGPoint) -> String? {
        let box = CGRect(x: point.x - 210, y: point.y - 26, width: 420, height: 52)
        guard let image = CGDisplayCreateImage(CGMainDisplayID(), rect: box) else {
            return nil
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        guard
            (try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])) != nil,
            let results = request.results, !results.isEmpty
        else { return nil }

        // Vision reports normalised coordinates with a bottom-left origin.
        let clickY = 0.5
        let best = results.min {
            abs($0.boundingBox.midY - clickY) < abs($1.boundingBox.midY - clickY)
        }
        guard let line = best?.topCandidates(1).first?.string,
            !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return line
    }

    // MARK: permissions

    /// Reports grants without prompting, so the UI can explain what is missing
    /// before the user triggers something that silently does nothing.
    static func permissions() {
        emit([
            "accessibility": AXIsProcessTrusted(),
            "screenRecording": CGPreflightScreenCaptureAccess(),
        ])
    }

    // MARK: output

    static func emit(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            fail("Could not encode the result")
        }
        FileHandle.standardOutput.write(data)
        exit(0)
    }

    static func fail(_ message: String) -> Never {
        let payload = ["error": message]
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
            FileHandle.standardError.write(data)
        }
        exit(1)
    }
}
