import SafariServices
import SwiftUI

/// The facts the screen shows, in one place.
enum Bridge {
    /// The appex's bundle id (apple/project.yml), which Safari knows it by.
    static let extensionIdentifier = "app.nullnet.contextmint.bridge.extension"
    /// docs/PRIVACY.md, as published.
    static let privacyPolicy = URL(string: "https://github.com/nullnet-app/contextmint-bridge/blob/main/docs/PRIVACY.md")!
    static let summary =
        "Lets ContextMint and your local MCP tools use your signed-in Safari tabs, without copying your passwords or cookies anywhere."
    static let connectStep = "Then open the ContextMint Bridge popup in Safari and choose Connect."
    /// The app's version, which is also the extension's (one MARKETING_VERSION).
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }
}

/// The container's one screen, on both platforms: what this is, how to turn
/// the extension on, and where to go next.
struct BridgeScreen: View {
    var body: some View {
        VStack(spacing: 20) {
            Image("BridgeMark")
                .resizable()
                .interpolation(.high)
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)
            Text("ContextMint Bridge")
                .font(.largeTitle.bold())
            Text(Bridge.summary)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            EnableSection()

            Text(Bridge.connectStep)
                .multilineTextAlignment(.center)

            VStack(spacing: 6) {
                Link("Privacy policy", destination: Bridge.privacyPolicy)
                Text("Version \(Bridge.version)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(32)
        .frame(maxWidth: 480)
        #if os(macOS)
        .fixedSize(horizontal: false, vertical: true)
        #endif
    }
}

#if os(macOS)
/// macOS: Safari's live answer for the extension, and its Extensions settings.
private struct EnableSection: View {
    /// What Safari says about the extension. `unknown` is not "off": it means
    /// Safari had no answer (it has not seen the extension yet, or could not say).
    enum SafariState: Equatable { case checking, on, off, unknown }

    @State private var state: SafariState = .checking
    @State private var openFailed = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 12) {
            Label(stateLine, systemImage: stateSymbol)
                .foregroundStyle(state == .on ? Color.green : Color.primary)
            Button("Open Safari Extensions Settings") {
                Task { await openSettings() }
            }
            .buttonStyle(.borderedProminent)
            if openFailed {
                Text("Safari did not open its settings. Open Safari, then choose Safari → Settings → Extensions.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        // Again whenever the person comes back from Safari's settings.
        .task(id: scenePhase) { await refresh() }
    }

    private var stateLine: String {
        switch state {
        case .checking: "Checking Safari…"
        case .on: "ContextMint Bridge is on in Safari."
        case .off: "ContextMint Bridge is off. Turn it on in Safari → Settings → Extensions."
        case .unknown:
            "Safari has not seen ContextMint Bridge yet. Quit and reopen Safari, then turn it on in Safari → Settings → Extensions."
        }
    }

    private var stateSymbol: String {
        switch state {
        case .checking: "hourglass"
        case .on: "checkmark.circle.fill"
        case .off: "circle"
        case .unknown: "questionmark.circle"
        }
    }

    private func refresh() async {
        do {
            let answer = try await SFSafariExtensionManager.stateOfSafariExtension(
                withIdentifier: Bridge.extensionIdentifier)
            state = answer.isEnabled ? .on : .off
        } catch {
            state = .unknown
        }
    }

    private func openSettings() async {
        do {
            try await SFSafariApplication.showPreferencesForExtension(withIdentifier: Bridge.extensionIdentifier)
            openFailed = false
        } catch {
            openFailed = true
        }
    }
}
#else
/// iOS: the steps, and a button to Safari's extension settings for this one.
private struct EnableSection: View {
    @State private var openFailed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Turn it on in Settings → Apps → Safari → Extensions → ContextMint Bridge → Allow, and allow it on the websites you want it to use.")
            Button("Open Safari Extensions Settings") {
                Task { await openSettings() }
            }
            .buttonStyle(.borderedProminent)
            .frame(maxWidth: .infinity)
            if openFailed {
                Text("Settings did not open. Open the Settings app and follow the steps above.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func openSettings() async {
        do {
            try await SFSafariSettings.openExtensionsSettings(forIdentifiers: [Bridge.extensionIdentifier])
            openFailed = false
        } catch {
            openFailed = true
        }
    }
}
#endif
