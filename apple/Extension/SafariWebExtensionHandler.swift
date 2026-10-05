import Foundation

/// The appex's principal class. The Safari web-extension point requires one,
/// and that is the only reason this exists.
///
/// ContextMint Bridge's manifest asks for no `nativeMessaging` permission, so
/// Safari never routes a `browser.runtime.sendNativeMessage` here: the
/// extension talks to no app, and its state lives in Safari's own extension
/// storage. If a request does arrive, it is completed with no reply.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
