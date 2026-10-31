// wordedits-transcribe <audio-file> [--locale en-US]
// Prints {"words":[{"w","start","end","conf"}]} to stdout. Errors go to stderr, exit 1.
import AVFoundation
import Foundation
import Speech

@main struct Transcribe {
  static func main() async {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let path = args.first, !path.hasPrefix("--") else {
      FileHandle.standardError.write("usage: wordedits-transcribe <audio-file> [--locale en-US]\n".data(using: .utf8)!)
      exit(2)
    }
    var localeId = "en-US"
    if let i = args.firstIndex(of: "--locale"), i + 1 < args.count { localeId = args[i + 1] }
    do {
      try await run(url: URL(fileURLWithPath: path), locale: Locale(identifier: localeId))
    } catch {
      FileHandle.standardError.write("transcription failed: \(error.localizedDescription)\n".data(using: .utf8)!)
      exit(1)
    }
  }

  static func run(url: URL, locale: Locale) async throws {
    let transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [],
      attributeOptions: [.audioTimeRange, .transcriptionConfidence])
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      FileHandle.standardError.write("installing speech model for \(locale.identifier)...\n".data(using: .utf8)!)
      try await request.downloadAndInstall()
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file = try AVAudioFile(forReading: url)
    let collector = Task { () -> [[String: Any]] in
      var words: [[String: Any]] = []
      for try await result in transcriber.results {
        for run in result.text.runs {
          guard let range = run.audioTimeRange else { continue }
          words.append([
            "w": String(result.text[run.range].characters),
            "start": range.start.seconds,
            "end": range.end.seconds,
            "conf": run.transcriptionConfidence ?? 1.0,
          ])
        }
      }
      return words
    }
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    let words = try await collector.value
    let data = try JSONSerialization.data(withJSONObject: ["words": words])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  }
}
