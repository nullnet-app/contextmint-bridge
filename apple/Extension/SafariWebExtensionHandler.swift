import Foundation

/// The appex's principal class. The Safari web-extension point requires one,
/// and that is the only reason this exists.
///
/// ContextMint Bridge's manifest asks for no `nativeMessaging` permission, so
/// Safari never routes a `browser.runtime.sendNativeMessage` here: the
/// extension talks to no app, and its state lives in Safari's own extension
/// storage. If a request does arrive, it is completed with no reply.
///
/// `nonisolated`, against the project's MainActor default: the extension
/// point instantiates this class and calls `beginRequest(with:)` on a
/// background queue, never the main thread. It holds no state, so there is
/// nothing to isolate. The compiler would not catch this: left MainActor, the
/// conformance is inferred isolated and Swift 6's dynamic isolation check
/// traps when Safari calls in off the main thread.
nonisolated final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
