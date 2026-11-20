import AppKit
import PDFKit
import SwiftUI
import WebKit

@MainActor
private struct AttachmentPDFView: NSViewRepresentable {
    let document: PDFDocument

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.document = document
        view.autoScales = true
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {}
}

@MainActor
enum AttachmentPDFPreview {
    private static let maxPDFBytes = 64 * 1024 * 1024

    static func open(blobURL: String, name: String, in webView: WKWebView, window: NSWindow) async throws {
        // WebKit 的 file:// 文档使用 blob:null/<uuid>。也接受 file origin 的序列化形式。
        // 仅允许对象 URL 的 UUID，绝不允许向页面传入 HTTP 或文件路径。
        let prefixes = ["blob:null/", "blob:file:///"]
        guard let prefix = prefixes.first(where: { blobURL.hasPrefix($0) }),
              blobURL.utf8.count == prefix.utf8.count + 36,
              UUID(uuidString: String(blobURL.dropFirst(prefix.count))) != nil,
              !name.isEmpty, name.utf8.count <= 1024 else {
            throw BridgeError.invalidParameter("PDF 附件地址或文件名无效。")
        }

        let result = try await webView.callAsyncJavaScript(
            """
            const response = await fetch(blobURL);
            if (!response.ok) return null;
            const length = Number(response.headers.get('content-length'));
            if (length > maxBytes) return null;
            const blob = await response.blob();
            if (!blob.size || blob.size > maxBytes) return null;
            return await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result.split(',')[1]);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            """,
            arguments: ["blobURL": blobURL, "maxBytes": maxPDFBytes],
            in: nil,
            contentWorld: .page
        )

        guard let base64 = result as? String, base64.utf8.count <= (maxPDFBytes + 2) / 3 * 4,
              let data = Data(base64Encoded: base64), data.count <= maxPDFBytes,
              data.prefix(1024).range(of: Data("%PDF-".utf8)) != nil,
              let document = PDFDocument(data: data), document.isLocked || document.pageCount > 0,
              webView.window === window, window.attachedSheet == nil else {
            throw BridgeError.invalidParameter("PDF 附件已失效、超过大小限制或无法读取。")
        }

        let hidden = CharacterSet.controlCharacters.union(.newlines)
        let title = String(name.filter { character in
            !character.unicodeScalars.contains(where: hidden.contains)
        }.prefix(160))
        let panel = NSPanel(contentRect: .zero, styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        panel.title = title
        panel.contentViewController = NSHostingController(rootView:
            VStack(spacing: 0) {
                HStack {
                    Text(title).lineLimit(1)
                    Spacer()
                    Button("关闭") { [weak window, weak panel] in
                        if let panel { window?.endSheet(panel) }
                    }
                    .keyboardShortcut(.cancelAction)
                }
                .padding(10)
                Divider()
                AttachmentPDFView(document: document)
            }
        )
        let width = min(880, window.frame.width)
        let height = min(720, max(320, window.frame.height - 72))
        panel.setContentSize(NSSize(width: width, height: height))
        window.beginSheet(panel, completionHandler: nil)
    }
}
