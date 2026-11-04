(() => {
    "use strict";

    /*
     * Platform Spoof — early Gateway IDENTIFY hook for Revenge Classic.
     * Derived from k1ng0p/PlatformSpoof (GPL-3.0-or-later).
     * Upstream: https://github.com/k1ng0p/PlatformSpoof
     *
     * Improvements over the previous port:
     * - Installs a WebSocket.prototype.send hook immediately when the plugin
     *   evaluates, before waiting for Discord's Gateway module to be discoverable.
     * - Keeps the Gateway socket.send hook as a fallback for alternate transports.
     * - Uses the stored selection at send time, so platform changes take effect
     *   on the next fresh IDENTIFY.
     * - On late plugin startup, forces one fresh IDENTIFY after the hook is ready.
     * - Supports Off by reconnecting with the real Android properties.
     *
     * Limitation: a plugin cannot rewrite a Gateway IDENTIFY that Discord sent
     * before this plugin was evaluated. In that case, the first Mobile presence
     * may briefly exist before the corrected reconnect. Preventing that entirely
     * requires a hook earlier than the plugin loader (e.g. a Revenge/native patch).
     */

    const api = typeof vendetta !== "undefined" ? vendetta : null;
    const storage = api?.plugin?.storage;
    const IDENTIFY_OPCODE = 2;
    const DEFAULT_PLATFORM = "desktop";
    const PLATFORMS = Object.freeze([
        { value: "off", label: "Off", detail: "Use Android's real platform" },
        { value: "desktop", label: "Desktop (Windows)", detail: "Show the Windows desktop client indicator" },
        { value: "web", label: "Web / Browser", detail: "Show the browser client indicator" },
        { value: "mobile", label: "Mobile (Android)", detail: "Show the Android mobile indicator" },
        { value: "meta", label: "Meta Quest / VR", detail: "Show the VR client indicator" },
        { value: "console", label: "Console", detail: "Show the console client indicator" },
    ]);

    let gatewayModule = null;
    let currentSocket = null;
    let gatewayOriginalSend = null;
    let gatewayWrappedSend = null;
    let gatewayHadOwnSend = false;

    let websocketPrototype = null;
    let websocketOriginalDescriptor = null;
    let websocketOriginalSend = null;
    let websocketWrappedSend = null;

    let discoveryTimer = null;
    let firstIdentifyObserved = false;
    let initialReconnectAttempted = false;
    let reconnectInProgress = false;
    let reconnectUnlockTimer = null;
    let unloaded = false;
    let gateReadyAnnounced = false;

    // The companion KernelSU module watches this marker in this Discord
    // process's logcat stream. It releases Discord's UID-level network gate
    // only after a platform-identification hook is actually installed.
    function announceGateReady(source) {
        if (gateReadyAnnounced) return;
        gateReadyAnnounced = true;
        try { globalThis.console?.log?.("DGATE_READY_V1", source || "hook"); } catch { /* logcat signal is best-effort */ }
    }

    function log(level, ...args) {
        try { api?.logger?.[level]?.("[PlatformSpoof]", ...args); } catch { /* optional logger */ }
    }

    function normalizePlatform(value) {
        return PLATFORMS.some((item) => item.value === value) ? value : DEFAULT_PLATFORM;
    }

    function selectedPlatform() {
        return normalizePlatform(storage?.platform);
    }

    function spoofProperties(platform = selectedPlatform()) {
        switch (platform) {
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
            case "off":
            default:
                return null;
        }
    }

    function rewriteIdentifyObject(packet) {
        if (!packet || packet.op !== IDENTIFY_OPCODE || !packet.d?.properties) return packet;
        firstIdentifyObserved = true;
        // A fresh IDENTIFY confirms the reconnect finished; allow another
        // platform change immediately instead of waiting for the safety timeout.
        if (reconnectInProgress) unlockReconnect();
        const spoof = spoofProperties();
        if (!spoof) return packet;
        return {
            ...packet,
            d: {
                ...packet.d,
                properties: { ...packet.d.properties, ...spoof },
            },
        };
    }

    function rewriteWebSocketFrame(data) {
        // Discord Gateway IDENTIFY frames are JSON text frames. Pass every other
        // frame through untouched; do not parse binary/audio/voice payloads.
        if (typeof data !== "string" || data.length < 2 || data.charCodeAt(0) !== 123) return data;
        try {
            const packet = JSON.parse(data);
            if (packet?.op !== IDENTIFY_OPCODE || !packet?.d?.properties) return data;
            const rewritten = rewriteIdentifyObject(packet);
            if (rewritten === packet || selectedPlatform() === "off") return data;
            return JSON.stringify(rewritten);
        } catch {
            return data;
        }
    }

    function installEarlyWebSocketHook() {
        try {
            const WebSocketCtor = globalThis.WebSocket || globalThis.window?.WebSocket;
            const prototype = WebSocketCtor?.prototype;
            if (!prototype || typeof prototype.send !== "function") {
                log("warn", "WebSocket.prototype.send is unavailable; using Gateway-module fallback only");
                return false;
            }
            if (websocketPrototype === prototype && prototype.send === websocketWrappedSend) return true;

            restoreEarlyWebSocketHook();
            websocketPrototype = prototype;
            websocketOriginalDescriptor = Object.getOwnPropertyDescriptor(prototype, "send") || null;
            websocketOriginalSend = prototype.send;

            websocketWrappedSend = function (data, ...rest) {
                const nextData = rewriteWebSocketFrame(data);
                return websocketOriginalSend.call(this, nextData, ...rest);
            };

            prototype.send = websocketWrappedSend;
            if (prototype.send !== websocketWrappedSend) {
                throw new Error("WebSocket.prototype.send is not writable");
            }
            log("info", "Installed early WebSocket send hook");
            announceGateReady("websocket");
            return true;
        } catch (error) {
            log("warn", "Could not install early WebSocket hook", error);
            restoreEarlyWebSocketHook();
            return false;
        }
    }

    function restoreEarlyWebSocketHook() {
        if (websocketPrototype && websocketWrappedSend && websocketPrototype.send === websocketWrappedSend) {
            try {
                if (websocketOriginalDescriptor) {
                    Object.defineProperty(websocketPrototype, "send", websocketOriginalDescriptor);
                } else {
                    delete websocketPrototype.send;
                }
            } catch (error) {
                log("warn", "Could not restore WebSocket.prototype.send", error);
            }
        }
        websocketPrototype = null;
        websocketOriginalDescriptor = null;
        websocketOriginalSend = null;
        websocketWrappedSend = null;
    }

    function getGatewayModule() {
        try {
            if (gatewayModule && typeof gatewayModule.getSocket === "function") return gatewayModule;
            gatewayModule = api?.metro?.findByProps?.("getSocket", "isConnected") || null;
            return gatewayModule;
        } catch (error) {
            log("warn", "Gateway module lookup failed", error);
            return null;
        }
    }

    function getSocket() {
        try { return getGatewayModule()?.getSocket?.() || null; }
        catch (error) {
            log("warn", "Could not get Gateway socket", error);
            return null;
        }
    }

    function restoreGatewaySocket() {
        if (currentSocket && gatewayWrappedSend && currentSocket.send === gatewayWrappedSend) {
            try {
                if (gatewayHadOwnSend) currentSocket.send = gatewayOriginalSend;
                else delete currentSocket.send;
            } catch (error) {
                log("warn", "Could not restore Gateway socket.send", error);
            }
        }
        currentSocket = null;
        gatewayOriginalSend = null;
        gatewayWrappedSend = null;
        gatewayHadOwnSend = false;
    }

    function patchGatewaySocket(socket) {
        if (!socket || typeof socket.send !== "function") return false;
        if (socket === currentSocket && socket.send === gatewayWrappedSend) return true;

        restoreGatewaySocket();
        currentSocket = socket;
        gatewayHadOwnSend = Object.prototype.hasOwnProperty.call(socket, "send");
        gatewayOriginalSend = socket.send;

        gatewayWrappedSend = function (...args) {
            if (args[0] === IDENTIFY_OPCODE && args[1]?.properties) {
                firstIdentifyObserved = true;
                if (reconnectInProgress) unlockReconnect();
                const spoof = spoofProperties();
                if (spoof) {
                    args[1] = {
                        ...args[1],
                        properties: { ...args[1].properties, ...spoof },
                    };
                }
            }
            return gatewayOriginalSend.apply(this, args);
        };

        try {
            socket.send = gatewayWrappedSend;
            if (socket.send !== gatewayWrappedSend) throw new Error("Gateway socket.send is not writable");
            log("info", "Installed Gateway socket.send fallback hook");
            announceGateReady("gateway");
            return true;
        } catch (error) {
            log("warn", "Could not patch Gateway socket.send", error);
            restoreGatewaySocket();
            return false;
        }
    }

    function unlockReconnect() {
        reconnectInProgress = false;
        if (reconnectUnlockTimer !== null) clearTimeout(reconnectUnlockTimer);
        reconnectUnlockTimer = null;
    }

    function forceIdentify(reason = "manual") {
        const socket = getSocket();
        if (!socket) {
            log("warn", "Cannot reconnect yet: Gateway socket is unavailable", reason);
            return false;
        }
        if (reconnectInProgress) return true;
        if (!patchGatewaySocket(socket)) return false;

        reconnectInProgress = true;
        if (reconnectUnlockTimer !== null) clearTimeout(reconnectUnlockTimer);
        reconnectUnlockTimer = setTimeout(unlockReconnect, 5000);

        try {
            // IDENTIFY carries client properties; RESUME does not. Clearing these
            // values asks Discord's Gateway client to establish a new IDENTIFY.
            socket.sessionId = null;
            socket.seq = 0;

            const ws = socket.webSocket;
            if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
                ws.close(1000, "Platform selection changed");
            } else if (!ws) {
                socket.close?.();
                setTimeout(() => {
                    try { socket.connect?.(); }
                    catch (error) { log("error", "Gateway reconnect failed", error); unlockReconnect(); }
                }, 350);
            } else if (ws.readyState === 2 || ws.readyState === 3) {
                // A close is already underway; the Gateway manager should reconnect.
            }
            log("info", "Requested fresh Gateway IDENTIFY", reason, "platform:", selectedPlatform());
            return true;
        } catch (error) {
            log("error", "Could not request fresh Gateway IDENTIFY", error);
            unlockReconnect();
            return false;
        }
    }

    function stopDiscovery() {
        if (discoveryTimer !== null) clearInterval(discoveryTimer);
        discoveryTimer = null;
    }

    function scanGateway() {
        const module = getGatewayModule();
        const socket = module?.getSocket?.() || null;
        if (!socket) return false;

        patchGatewaySocket(socket);
        const wsState = socket.webSocket?.readyState;
        let connected = false;
        try { connected = Boolean(module?.isConnected?.()); } catch { /* optional */ }
        connected = connected || Boolean(socket.sessionId) || wsState === 1;

        if (connected && !firstIdentifyObserved && !initialReconnectAttempted && selectedPlatform() !== "off") {
            // The plugin loaded after a Gateway socket was already open. The
            // first frame may have escaped before our hook, so request one fresh
            // IDENTIFY now that both hooks are installed.
            initialReconnectAttempted = true;
            forceIdentify("late plugin startup");
        }

        if (firstIdentifyObserved || initialReconnectAttempted) stopDiscovery();
        return true;
    }

    function setPlatform(value) {
        const next = normalizePlatform(value);
        if (!storage || selectedPlatform() === next) return;
        storage.platform = next;
        forceIdentify("platform changed");
        try { api?.ui?.toasts?.showToast?.(`Platform Spoof: ${PLATFORMS.find((item) => item.value === next)?.label || next}`); }
        catch { /* optional toast API */ }
    }

    function Settings() {
        const React = api?.metro?.common?.React || globalThis.React;
        const RN = api?.metro?.common?.ReactNative || globalThis.ReactNative;
        if (!React || !RN || !storage) return null;

        const state = api?.storage?.useProxy ? api.storage.useProxy(storage) : storage;
        const active = normalizePlatform(state.platform);
        const h = React.createElement;
        const Pressable = RN.Pressable || RN.TouchableOpacity || RN.View;

        const rows = PLATFORMS.map((item) => {
            const selected = active === item.value;
            return h(Pressable, {
                key: item.value,
                onPress: () => setPlatform(item.value),
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
            h(RN.Text, { style: { color: "#ffffff", fontSize: 14, fontWeight: selected ? "700" : "500" } }, `${selected ? "✓  " : ""}${item.label}`),
            h(RN.Text, { style: { color: "#b5bac1", fontSize: 11, marginTop: 3 } }, item.detail));
        });

        return h(RN.ScrollView, {
            contentContainerStyle: { padding: 16, paddingBottom: 32 },
            keyboardShouldPersistTaps: "handled",
        },
        h(RN.Text, { style: { color: "#ffffff", fontSize: 18, fontWeight: "800", marginBottom: 5 } }, "Platform Spoof"),
        h(RN.Text, { style: { color: "#b5bac1", fontSize: 12, lineHeight: 18, marginBottom: 8 } },
            "The chosen platform is applied to every Gateway IDENTIFY while the plugin is active. Changing it reconnects Discord."),
        ...rows,
        h(Pressable, {
            onPress: () => forceIdentify("manual reconnect"),
            accessibilityRole: "button",
            style: { marginTop: 16, padding: 13, borderRadius: 10, backgroundColor: "#5865f2", alignItems: "center" },
        }, h(RN.Text, { style: { color: "#ffffff", fontWeight: "700" } }, "Reconnect now")),
        h(RN.Text, { style: { color: "#949ba4", fontSize: 10, lineHeight: 15, marginTop: 16 } },
            "Early WebSocket interception is best-effort. If Discord sent its first IDENTIFY before this plugin loaded, that first presence cannot be recalled; the plugin requests a corrected reconnect."));
    }

    function onLoad() {
        if (!storage) throw new Error("Revenge plugin storage API is unavailable");
        unloaded = false;
        storage.platform = normalizePlatform(storage.platform);
        firstIdentifyObserved = false;
        initialReconnectAttempted = false;
        reconnectInProgress = false;

        // Crucial: install this before attempting Metro/Gateway discovery.
        // It catches the first IDENTIFY if the plugin starts early enough.
        installEarlyWebSocketHook();

        // Keep the high-level fallback until the first IDENTIFY is observed, or
        // until we have issued a corrective reconnect for a late plugin start.
        if (!scanGateway()) {
            discoveryTimer = setInterval(() => {
                if (unloaded) return stopDiscovery();
                scanGateway();
            }, 200);
        }

        globalThis.__ps = {
            status: () => {
                const socket = getSocket();
                log("log", "early WebSocket hook:", Boolean(websocketPrototype && websocketPrototype.send === websocketWrappedSend),
                    "gateway hook:", Boolean(socket && socket === currentSocket && socket.send === gatewayWrappedSend),
                    "platform:", selectedPlatform(), "identify observed:", firstIdentifyObserved,
                    "session:", socket?.sessionId, "state:", socket?.connectionState);
            },
            reconnect: () => forceIdentify("console helper"),
            sessions: () => {
                try {
                    const sessions = api?.metro?.findByProps?.("getSessions")?.getSessions?.();
                    if (!sessions) return;
                    Object.values(sessions).forEach((entry) => log("log", entry?.sessionId?.slice?.(0, 8), "→", entry?.clientInfo?.client, "/", entry?.clientInfo?.os));
                } catch (error) { log("warn", "Could not inspect sessions", error); }
            },
        };

        log("info", "Loaded; selected platform:", selectedPlatform());
    }

    function onUnload() {
        unloaded = true;
        stopDiscovery();
        if (reconnectUnlockTimer !== null) clearTimeout(reconnectUnlockTimer);
        reconnectUnlockTimer = null;
        reconnectInProgress = false;
        restoreGatewaySocket();
        restoreEarlyWebSocketHook();
        if (globalThis.__ps) delete globalThis.__ps;
        log("info", "Unloaded");
    }

    return { onLoad, onUnload, settings: Settings };
})();
