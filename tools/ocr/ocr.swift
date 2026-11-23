// Text boxes on still frames (macOS Vision, on-device): one JSON line per input file,
// {"file":…, "boxes":[{"text":…, "x0":…, "y0":…, "x1":…, "y1":…, "conf":…}]} in frame fractions, origin top-left.
// Used to measure how much of a frame its words cover (build list 5, item 12) — the same quantity as the
// reference index's textArea (sum of OCR box areas).
import Foundation
import Vision
import AppKit

for path in CommandLine.arguments.dropFirst() {
  var boxes: [[String: Any]] = []
  if let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
    for o in req.results ?? [] {
      guard let c = o.topCandidates(1).first, c.confidence >= 0.4 else { continue }
      let b = o.boundingBox
      boxes.append(["text": c.string, "x0": b.minX, "y0": 1 - b.maxY, "x1": b.maxX, "y1": 1 - b.minY, "conf": c.confidence])
    }
  }
  let row: [String: Any] = ["file": path, "boxes": boxes]
  if let d = try? JSONSerialization.data(withJSONObject: row), let s = String(data: d, encoding: .utf8) { print(s) }
}
