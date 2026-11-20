import Foundation
import Network

/// Bonjour 发现骨架。配对、TLS、增量同步和冲突解决由 V1 同步任务补全（docs/05-lan-sync.md）。
/// 当前仅浏览 `_deepseekchat._tcp` 服务数量，不建立任何连接、不交换任何数据。
final class LANDiscoveryService {
    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "com.deepseek.mac.discovery")
    private let lock = NSLock()
    private var _deviceCount = 0

    var deviceCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _deviceCount
    }

    func start(onResult: @escaping (Int) -> Void) {
        stop()
        let browser = NWBrowser(for: .bonjour(type: "_deepseekchat._tcp", domain: nil), using: .tcp)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            self.lock.lock()
            self._deviceCount = results.count
            let count = self._deviceCount
            self.lock.unlock()
            DispatchQueue.main.async { onResult(count) }
        }
        browser.stateUpdateHandler = { state in
            if case .failed(let error) = state {
                NSLog("LAN discovery failed: %@", String(describing: error))
            }
        }
        self.browser = browser
        browser.start(queue: queue)
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }
}
