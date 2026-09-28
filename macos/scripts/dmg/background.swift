// Draws the installer window's background: Webyar's name, an arrow from the
// app to the Applications folder, and the one step to take — in Persian and
// English — at 1x and 2x. Run by make-dmg.sh: `swift background.swift <out-dir>`.
import AppKit
import CoreText

let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let scriptDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

// IRANSans, the app's own Persian face (bundled with the Windows app).
let fontFile = scriptDir.appendingPathComponent("../../../windows-native/src/Webyar.App/Assets/Fonts/IRANSans.ttc").standardized
CTFontManagerRegisterFontsForURL(fontFile as CFURL, .process, nil)

func persian(_ size: CGFloat, bold: Bool = false) -> NSFont {
    for name in bold ? ["IRANSans-Bold", "IRANSansWeb-Bold", "IRANSans Bold"] : ["IRANSans", "IRANSansWeb", "IRANSans-Regular"] {
        if let f = NSFont(name: name, size: size) { return f }
    }
    return NSFont.systemFont(ofSize: size, weight: bold ? .bold : .regular)
}

let brand = NSColor(srgbRed: 0x3B / 255, green: 0x7A / 255, blue: 0xF2 / 255, alpha: 1)
let ink = NSColor(srgbRed: 0.10, green: 0.13, blue: 0.20, alpha: 1)
let muted = NSColor(srgbRed: 0.38, green: 0.43, blue: 0.52, alpha: 1)
let size = NSSize(width: 660, height: 440)
// Where make-dmg.sh places the two icons (their centres), in window points.
let appCentre = NSPoint(x: 170, y: 205), appsCentre = NSPoint(x: 490, y: 205)

func text(_ s: String, _ font: NSFont, _ color: NSColor, centreX: CGFloat, top: CGFloat, rtl: Bool = false) {
    let p = NSMutableParagraphStyle()
    p.alignment = .center
    p.baseWritingDirection = rtl ? .rightToLeft : .leftToRight
    let a = NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: p])
    let w: CGFloat = 600
    a.draw(in: NSRect(x: centreX - w / 2, y: top, width: w, height: a.size().height + 4))
}

func draw() {
    // A quiet brand wash, lighter at the top.
    NSGradient(colors: [NSColor(srgbRed: 0.975, green: 0.982, blue: 1, alpha: 1),
                        NSColor(srgbRed: 0.918, green: 0.945, blue: 0.996, alpha: 1)])!
        .draw(in: NSRect(origin: .zero, size: size), angle: 90)
    // Two soft rings behind the icons.
    for c in [appCentre, appsCentre] {
        let r: CGFloat = 78
        NSColor.white.withAlphaComponent(0.85).setFill()
        NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)).fill()
        brand.withAlphaComponent(0.12).setStroke()
        let ring = NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
        ring.lineWidth = 1.5
        ring.stroke()
    }

    text("Webyar", NSFont.systemFont(ofSize: 26, weight: .bold), ink, centreX: size.width / 2, top: 26)
    text("نصب وب‌یار برای مک", persian(14), muted, centreX: size.width / 2, top: 62, rtl: true)

    // The arrow: from the app towards Applications.
    let y = appCentre.y, from = appCentre.x + 92, to = appsCentre.x - 92
    let shaft = NSBezierPath()
    shaft.move(to: NSPoint(x: from, y: y))
    shaft.line(to: NSPoint(x: to - 10, y: y))
    shaft.lineWidth = 3.5
    shaft.lineCapStyle = .round
    shaft.setLineDash([2, 9], count: 2, phase: 0)
    brand.setStroke()
    shaft.stroke()
    let head = NSBezierPath()
    head.move(to: NSPoint(x: to, y: y))
    head.line(to: NSPoint(x: to - 16, y: y - 11))
    head.line(to: NSPoint(x: to - 16, y: y + 11))
    head.close()
    brand.setFill()
    head.fill()

    text("وب‌یار را روی پوشهٔ Applications بکشید", persian(15, bold: true), ink, centreX: size.width / 2, top: 318, rtl: true)
    text("Drag Webyar onto the Applications folder", NSFont.systemFont(ofSize: 12.5, weight: .medium), muted, centreX: size.width / 2, top: 346)
    text("اگر macOS اجازهٔ باز شدن نداد: System Settings ← Privacy & Security ← Open Anyway",
         persian(10.5), muted, centreX: size.width / 2, top: 390, rtl: true)
    text("If macOS won’t open it: System Settings → Privacy & Security → Open Anyway",
         NSFont.systemFont(ofSize: 10), muted.withAlphaComponent(0.8), centreX: size.width / 2, top: 408)
}

for scale in [1, 2] {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width) * scale, pixelsHigh: Int(size.height) * scale,
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = size
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    // Top-left origin, as Finder lays the window out.
    ctx.cgContext.translateBy(x: 0, y: size.height)
    ctx.cgContext.scaleBy(x: 1, y: -1)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx.cgContext, flipped: true)
    draw()
    NSGraphicsContext.restoreGraphicsState()
    let name = scale == 1 ? "background.png" : "background@2x.png"
    try! rep.representation(using: .png, properties: [:])!.write(to: outDir.appendingPathComponent(name))
}
print("background written to \(outDir.path)")
