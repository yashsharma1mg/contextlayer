import AppKit
import AVFoundation
import Foundation

@main
struct MediaExtractor {
    static func main() async throws {
        guard CommandLine.arguments.count == 3 else {
            throw NSError(domain: "ContextLayerMedia", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Usage: media-extractor INPUT OUTPUT_DIRECTORY",
            ])
        }
        let input = URL(fileURLWithPath: CommandLine.arguments[1])
        let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        let asset = AVURLAsset(url: input)
        let duration = try await asset.load(.duration)
        let seconds = max(0, CMTimeGetSeconds(duration))

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1280, height: 1280)
        generator.requestedTimeToleranceBefore = CMTime(seconds: 1, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
        let frameCount = min(12, max(1, Int(ceil(seconds / 30))))
        var writtenFrames = 0
        var frameTimestamps: [Double] = []
        for index in 0..<frameCount {
            let position = seconds > 0 ? seconds * Double(index) / Double(frameCount) : 0
            do {
                var actualTime = CMTime.zero
                let image = try generator.copyCGImage(
                    at: CMTime(seconds: position, preferredTimescale: 600),
                    actualTime: &actualTime
                )
                let bitmap = NSBitmapImageRep(cgImage: image)
                guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.78]) else {
                    continue
                }
                try data.write(to: output.appendingPathComponent(String(format: "frame-%03d.jpg", index + 1)))
                writtenFrames += 1
                frameTimestamps.append(CMTimeGetSeconds(actualTime))
            } catch {
                continue
            }
        }

        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        var audioWritten = false
        if !audioTracks.isEmpty,
           let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) {
            exporter.outputURL = output.appendingPathComponent("audio.m4a")
            exporter.outputFileType = .m4a
            await withCheckedContinuation { continuation in
                exporter.exportAsynchronously { continuation.resume() }
            }
            audioWritten = exporter.status == .completed
        }

        let result: [String: Any] = [
            "durationSeconds": seconds,
            "frameCount": writtenFrames,
            "frameTimestamps": frameTimestamps,
            "audio": audioWritten,
        ]
        let json = try JSONSerialization.data(withJSONObject: result)
        FileHandle.standardOutput.write(json)
    }
}
