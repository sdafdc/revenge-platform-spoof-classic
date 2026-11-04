(() => {
    /*
     * Platform Spoof — Revenge Classic / Vendetta-compatible port
     *
     * Original project: https://github.com/k1ng0p/PlatformSpoof
     * Original author: k1ng0p
     * Original source identifies GPL-3.0-or-later.
     *
     * This port targets the legacy Vendetta-compatible plugin loader shipped in
     * Revenge bundle 1.12.1 (commit 0980cfc). It does not use Vencord imports.
     *
     * IMPORTANT: Runtime module discovery and gateway behavior must still be
     * confirmed on the user's Android/Discord build. This file has been tested
     * against a mocked Revenge Classic runtime, not on a physical device.
     */
    "use strict";

    const pluginApi = vendetta;
    const storage = pluginApi?.plugin?.storage;
    const React = pluginApi?.metro?.common?.React || globalThis.React;
    const RN = pluginApi?.metro?.common?.ReactNative || globalThis.ReactNative;

    const IDENTIFY_OPCODE = 2;
    const DEFAULT_PLATFORM = "desktop";
    const PLATFORMS = Object.freeze([
        { value: "off", label: "Off", detail: "Use Android's real platform" },
        { value: "desktop", label: "Desktop (Windows)", detail: "Show the desktop client indicator" },
        { value: "web", label: "Web / Browser", detail: "Show the browser client indicator" },
        { value: "mobile", label: "Mobile (Android)", detail: "Show the Android mobile indicator" },
        { value: "meta", label: "Meta Quest / VR", detail: "Show the VR client indicator" },
        { value: "console", label: "Console", detail: "Show the console client indicator" },
    ]);

    let gatewayModule = null;
    let currentSocket = null;
    let originalSend = null;
    let wrappedSend = null;
    let hadOwnSend = false;
    let pollHandle = null;
    let initialReconnectDone = false;

    function normalizePlatform(value) {
        return PLATFORMS.some((entry) => entry.value === value) ? value : DEFAULT_PLATFORM;
    }

    function selectedPlatform() {
        return normalizePlatform(storage?.platform);
    }

    function getSpoofProperties() {
        switch (selectedPlatform()) {
            case "desktop":
                return { os: "Windows", browser: "Discord Client", device: "" };
            case "web":
                return { os: "Linux", browser: "Chrome", device: "" };
            case "mobile":
                return { os: "Android", browser: "Discord Android", device: "Discord Android" };
            case "meta":
                return { os: "Android", browser: "Discord VR", device: "Meta Quest" };
            case "console":
                return { os: "Playstation", browser: "Discord Embedded", device: "PlayStation" };
            default:
                return null;
        }
    }

    function getGatewayModule() {
        try {
            if (gatewayModule && typeof gatewayModule.getSocket === "function") {
                return gatewayModule;
            }
            gatewayModule = pluginApi.metro.findByProps("getSocket", "isConnected") || null;
            return gatewayModule;
        } catch (error) {
            pluginApi.logger?.warn?.("[PlatformSpoof] Gateway module lookup failed", error);
            return null;
        }
    }

    function getSocket() {
        try {
            return getGatewayModule()?.getSocket?.() || null;
        } catch (error) {
            pluginApi.logger?.warn?.("[PlatformSpoof] Could not get gateway socket", error);
            return null;
        }
    }

    function restoreSocket() {
        if (currentSocket && wrappedSend && currentSocket.send === wrappedSend) {
            try {
                if (hadOwnSend) currentSocket.send = originalSend;
                else delete currentSocket.send;
            } catch (error) {
                pluginApi.logger?.warn?.("[PlatformSpoof] Could not restore gateway send", error);
            }
        }
        currentSocket = null;
        originalSend = null;
        wrappedSend = null;
        hadOwnSend = false;
    }

    function patchSocket(socket) {
        if (!socket || typeof socket.send !== "function") return false;
        if (socket === currentSocket && socket.send === wrappedSend) return true;

        restoreSocket();

        currentSocket = socket;
        hadOwnSend = Object.prototype.hasOwnProperty.call(socket, "send");
        originalSend = socket.send;

        wrappedSend = function (...args) {
            const opcode = args[0];
            const data = args[1];

            if (opcode === IDENTIFY_OPCODE && data?.properties) {
                const spoof = getSpoofProperties();
                if (spoof) {
                    // Copy the payload rather than mutating Discord's original object.
                    args[1] = {
                        ...data,
                        properties: { ...data.properties, ...spoof },
                    };
                }
            }

            return originalSend.apply(this, args);
        };

        try {
            socket.send = wrappedSend;
            if (socket.send !== wrappedSend) throw new Error("Gateway send method is not writable");
            pluginApi.logger?.info?.("[PlatformSpoof] Gateway IDENTIFY hook installed");
            return true;
        } catch (error) {
            restoreSocket();
            pluginApi.logger?.error?.("[PlatformSpoof] Failed to patch gateway socket", error);
            return false;
        }
    }

    function forceIdentify() {
        const socket = getSocket();
        if (!socket) {
            pluginApi.logger?.warn?.("[PlatformSpoof] Gateway socket is not available yet");
            return false;
        }
        if (!patchSocket(socket)) return false;

        try {
            // A RESUME packet does not include client properties. Clearing the
            // session fields makes the reconnect negotiate a fresh IDENTIFY.
            socket.sessionId = null;
            socket.seq = 0;

            const ws = socket.webSocket;
            if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
                ws.close(1000);
            } else if (!ws) {
                socket.close?.();
                setTimeout(() => {
                    try { socket.connect?.(); } catch (error) {
                        pluginApi.logger?.error?.("[PlatformSpoof] Gateway reconnect failed", error);
                    }
                }, 500);
            }
            return true;
        } catch (error) {
            pluginApi.logger?.error?.("[PlatformSpoof] Could not request a fresh IDENTIFY", error);
            return false;
        }
    }

    function scanGateway() {
        const socket = getSocket();
        if (socket) patchSocket(socket);

        const connected = (() => {
            try { return Boolean(getGatewayModule()?.isConnected?.()); }
            catch { return false; }
        })();

        if (socket && connected && !initialReconnectDone) {
            initialReconnectDone = true;
            forceIdentify();
        }

        return Boolean(socket);
    }

    function setPlatform(value) {
        const next = normalizePlatform(value);
        if (!storage || storage.platform === next) return;
        storage.platform = next;
        forceIdentify();
        try {
            pluginApi.ui?.toasts?.showToast?.(`Platform Spoof: ${PLATFORMS.find((p) => p.value === next)?.label || next}`);
        } catch { /* Toasts are optional. */ }
    }

    function Settings() {
        if (!React || !RN) return null;
        const state = pluginApi.storage.useProxy(storage);
        const active = normalizePlatform(state.platform);
        const h = React.createElement;
        const Pressable = RN.Pressable || RN.TouchableOpacity || RN.View;

        const rows = PLATFORMS.map((entry) => {
            const selected = active === entry.value;
            return h(Pressable, {
                key: entry.value,
                onPress: () => setPlatform(entry.value),
                accessibilityRole: "button",
                style: {
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                    marginTop: 8,
                    borderRadius: 10,
                    backgroundColor: selected ? "#303b70" : "#2b2d31",
                    borderWidth: selected ? 1 : 0,
                    borderColor: selected ? "#7289da" : "transparent",
                },
            },
            h(RN.Text, {
                style: { color: "#ffffff", fontSize: 14, fontWeight: selected ? "700" : "500" },
            }, `${selected ? "✓  " : ""}${entry.label}`),
            h(RN.Text, {
                style: { color: "#b5bac1", fontSize: 11, marginTop: 3 },
            }, entry.detail));
        });

        return h(RN.ScrollView, {
            contentContainerStyle: { padding: 16, paddingBottom: 32 },
            keyboardShouldPersistTaps: "handled",
        },
        h(RN.Text, { style: { color: "#ffffff", fontSize: 18, fontWeight: "800", marginBottom: 5 } }, "Platform Spoof"),
        h(RN.Text, { style: { color: "#b5bac1", fontSize: 12, lineHeight: 18, marginBottom: 8 } },
            "Choose the client platform Discord receives during Gateway IDENTIFY. Selecting an option reconnects your Discord session."),
        ...rows,
        h(Pressable, {
            onPress: () => forceIdentify(),
            accessibilityRole: "button",
            style: { marginTop: 16, padding: 13, borderRadius: 10, backgroundColor: "#5865f2", alignItems: "center" },
        }, h(RN.Text, { style: { color: "#ffffff", fontWeight: "700" } }, "Reconnect now")),
        h(RN.Text, { style: { color: "#949ba4", fontSize: 10, lineHeight: 15, marginTop: 16 } },
            "Experimental Revenge Classic port. If Discord changes its gateway internals, the platform indicator may stop updating. Use at your own risk."));
    }

    function onLoad() {
        if (!storage) throw new Error("Revenge plugin storage API is unavailable");
        storage.platform = normalizePlatform(storage.platform);
        initialReconnectDone = false;

        scanGateway();
        pollHandle = setInterval(scanGateway, 1000);

        // Console helpers retained from the original PlatformSpoof project.
        globalThis.__ps = {
            status: () => {
                const socket = getSocket();
                pluginApi.logger?.log?.("[PlatformSpoof] patched:", Boolean(socket && socket === currentSocket && socket.send === wrappedSend),
                    "| platform:", selectedPlatform(), "| session:", socket?.sessionId, "| state:", socket?.connectionState);
            },
            reconnect: () => forceIdentify(),
            sessions: () => {
                try {
                    const sessionsModule = pluginApi.metro.findByProps("getSessions");
                    const sessions = sessionsModule?.getSessions?.();
                    if (!sessions) return;
                    Object.values(sessions).forEach((entry) => {
                        pluginApi.logger?.log?.(entry?.sessionId?.slice?.(0, 8), "→", entry?.clientInfo?.client, "/", entry?.clientInfo?.os);
                    });
                } catch (error) {
                    pluginApi.logger?.warn?.("[PlatformSpoof] Could not inspect sessions", error);
                }
            },
        };

        pluginApi.logger?.info?.("Platform Spoof loaded; selected platform:", selectedPlatform());
    }

    function onUnload() {
        if (pollHandle !== null) clearInterval(pollHandle);
        pollHandle = null;
        restoreSocket();
        if (globalThis.__ps) delete globalThis.__ps;
        initialReconnectDone = false;
        pluginApi.logger?.info?.("[PlatformSpoof] Unloaded");
    }

    return {
        onLoad,
        onUnload,
        settings: Settings,
    };
})();
