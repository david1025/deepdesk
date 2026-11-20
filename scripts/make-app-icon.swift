// macOS App 图标合成（Big Sur 模板）：1024×1024 画布，824×824 连续圆角方形（squircle）。
// 生成浅色（白底）与深色（深空底）两个变体，写入 Asset Catalog 的 AppIcon.appiconset，
// 系统按 Luminosity 外观自动切换。
// 用法：swiftc -O make-app-icon.swift -o make-app-icon && ./make-app-icon
import AppKit
import CoreGraphics

let logoPath = "apps/windows/src/DeepDesk/Assets/deepdesk-logo.png"
let assetDir = "apps/macos/Config/AppIcon.xcassets/AppIcon.appiconset"
let width = 1024, height = 1024, inset = 100, squircle = 824
let radius = CGFloat(185)

struct Variant {
    let name: String          // 输出文件名
    let background: (r: CGFloat, g: CGFloat, b: CGFloat)
    let strokeAlpha: CGFloat  // 内侧高光描边透明度
}

// 浅色：白色底；深色：深空蓝黑底（与鲸鱼蓝 #4D6BFE 同族色调，深色模式下有足够对比度）
let variants: [Variant] = [
    Variant(name: "icon-light.png", background: (1, 1, 1), strokeAlpha: 0.08),
    Variant(name: "icon-dark.png",  background: (0.043, 0.059, 0.11), strokeAlpha: 0.10),
]

try FileManager.default.createDirectory(atPath: assetDir, withIntermediateDirectories: true)

guard let logoSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: logoPath) as CFURL, nil),
      let logo = CGImageSourceCreateImageAtIndex(logoSource, 0, nil) else {
    fatalError("cannot load logo")
}
let logoW = logo.width, logoH = logo.height
print("logo \(logoW)x\(logoH)")

// 1. 缩到 128×128 求 alpha 包围盒（logo 非透明内容的实际范围；原图圆形不居中，必须按内容定位）
let probeSize = 128
let probe = CGContext(data: nil, width: probeSize, height: probeSize, bitsPerComponent: 8,
                      bytesPerRow: probeSize * 4, space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
probe.interpolationQuality = .medium
probe.draw(logo, in: CGRect(x: 0, y: 0, width: probeSize, height: probeSize))
let pixels = probe.data!.assumingMemoryBound(to: UInt8.self)
var minX = probeSize, maxX = 0, minY = probeSize, maxY = 0
for y in 0..<probeSize {
    for x in 0..<probeSize {
        let alpha = pixels[(y * probeSize + x) * 4 + 3]
        if alpha > 16 {
            minX = min(minX, x); maxX = max(maxX, x)
            minY = min(minY, y); maxY = max(maxY, y)
        }
    }
}
// probe 坐标系 y 向下；CGImage cropping 也用 top-left 原点
let contentRect = CGRect(x: CGFloat(minX) / CGFloat(probeSize) * CGFloat(logoW),
                         y: CGFloat(minY) / CGFloat(probeSize) * CGFloat(logoH),
                         width: CGFloat(maxX - minX + 1) / CGFloat(probeSize) * CGFloat(logoW),
                         height: CGFloat(maxY - minY + 1) / CGFloat(probeSize) * CGFloat(logoH))
print("content rect: \(contentRect)")

for variant in variants {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))

    let rect = CGRect(x: inset, y: inset, width: squircle, height: squircle)
    let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    context.addPath(path)
    context.clip()
    context.setFillColor(CGColor(red: variant.background.r,
                                 green: variant.background.g,
                                 blue: variant.background.b, alpha: 1))
    context.fill(rect)

    // 内容 → squircle 的等比缩放：fitRatio 对齐 DeepSeek 官方图标留白（鲸鱼约占方块 85%），
    //（图像 top-left 原点 → CG bottom-left 原点的 y 翻转已并入 originY 推导）
    let fitRatio: CGFloat = 0.85
    let scale = min(CGFloat(squircle) / contentRect.width, CGFloat(squircle) / contentRect.height) * fitRatio
    let drawW = CGFloat(logoW) * scale
    let drawH = CGFloat(logoH) * scale
    let originX = rect.midX - contentRect.midX * scale
    let originY = rect.midY - drawH + contentRect.midY * scale
    context.interpolationQuality = .high
    context.draw(logo, in: CGRect(x: originX, y: originY, width: drawW, height: drawH))

    // 轻微内侧高光描边（模拟系统图标的玻璃质感，深浅底都用白色微光）
    context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: variant.strokeAlpha))
    context.setLineWidth(2)
    context.addPath(path)
    context.strokePath()

    let master = context.makeImage()!
    let outURL = URL(fileURLWithPath: "\(assetDir)/\(variant.name)") as CFURL
    CGImageDestinationCreateWithURL(outURL, "public.png" as CFString, 1, nil).map {
        CGImageDestinationAddImage($0, master, nil)
        CGImageDestinationFinalize($0)
    }
    print("written \(variant.name)")
}
