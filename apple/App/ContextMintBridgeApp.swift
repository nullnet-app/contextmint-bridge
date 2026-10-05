import SwiftUI

/// The container app ContextMint Bridge for Safari ships in. Apple requires a
/// Safari web extension to come inside an app; this one is that app and an
/// enable guide, nothing more: no accounts, no network, no analytics. The
/// extension (the appex beside it) is the product, and it pairs from its own
/// popup in Safari.
@main
struct ContextMintBridgeApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(QuitWithWindow.self) private var quitWithWindow
    #endif

    var body: some Scene {
        WindowGroup {
            BridgeScreen()
        }
        #if os(macOS)
        .windowResizability(.contentSize)
        #endif
    }
}

#if os(macOS)
import AppKit

/// One window and nothing to do without it, so closing it quits the app.
final class QuitWithWindow: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
#endif
