/*
 * Platform Spoof — experimental Revenge Classic / Vendetta-API port
 *
 * This is an UNTESTED compatibility prototype. It is not affiliated with
 * Discord, Revenge, Vendetta, or the author of the desktop plugin it was
 * inspired by.
 *
 * When Discord sends a Gateway IDENTIFY (opcode 2), this plugin changes the
 * client properties to Windows / Discord Client. It does not alter messages,
 * credentials, or account data.
 */

const IDENTIFY_OPCODE = 2;
const WINDOWS_PROPERTIES = {
    os: "Windows",
    browser: "Discord Client",
    device: ""
};

let unpatch = null;
let scanTimer = null;
let patchedSocket = null;

function findSocket() {
    try {
        const module = vendetta?.metro?.findByProps?.("getSocket", "isConnected");
        return module?.getSocket?.() ?? null;
    } catch (error) {
        console.warn("[PlatformSpoof] Could not locate Discord gateway socket:", error);
        return null;
    }
}

function patchSocket(socket) {
    if (!socket || typeof socket.send !== "function" || socket === patchedSocket) {
        return;
    }

    // Remove a previous socket patch if Discord replaced its gateway socket.
    if (unpatch) {
        try { unpatch(); } catch (_) {}
        unpatch = null;
    }

    try {
        unpatch = vendetta.patcher.before("send", socket, (args) => {
            const [opcode, data, flag] = args;

            if (opcode === IDENTIFY_OPCODE && data?.properties) {
                const updatedData = {
                    ...data,
                    properties: {
                        ...data.properties,
                        ...WINDOWS_PROPERTIES
                    }
                };
                return [opcode, updatedData, flag];
            }

            return args;
        });

        patchedSocket = socket;
        console.log("[PlatformSpoof] Gateway send hook installed. Windows spoof applies on the next IDENTIFY.");
    } catch (error) {
        console.error("[PlatformSpoof] Failed to patch gateway socket:", error);
    }
}

function scanForSocket() {
    const socket = findSocket();
    if (socket) patchSocket(socket);
}

export default () => {
    // The gateway module/socket may not exist yet when a plugin starts.
    scanForSocket();
    scanTimer = setInterval(scanForSocket, 1500);

    return () => {
        if (scanTimer) clearInterval(scanTimer);
        scanTimer = null;

        if (unpatch) {
            try { unpatch(); } catch (_) {}
        }

        unpatch = null;
        patchedSocket = null;
        console.log("[PlatformSpoof] Unloaded.");
    };
};
