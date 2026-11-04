/* Mocked tests for the legacy Revenge/Vendetta-compatible plugin loader. */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const crypto = require('crypto');

const source = fs.readFileSync(__dirname + '/../index.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync(__dirname + '/../manifest.json', 'utf8'));
assert.strictEqual(manifest.main, 'index.js');
assert.strictEqual(manifest.hash, crypto.createHash('sha256').update(source).digest('hex'));
assert.ok(manifest.name && Array.isArray(manifest.authors));

function createRuntime({ connected = false, wsReadyState = 0, prePluginIdentify = false } = {}) {
    const logs = [];
    const consoleMessages = [];
    const rawFrames = [];
    const gatewayFrames = [];
    let closeCount = 0;
    let connectCount = 0;

    function MockWebSocket() {}
    MockWebSocket.prototype.send = function (data) {
        rawFrames.push(data);
        return 'ws-sent';
    };

    const ws = Object.create(MockWebSocket.prototype);
    ws.readyState = wsReadyState;
    ws.close = function (code, reason) {
        closeCount++;
        this.readyState = 3;
        this.closeCode = code;
        this.closeReason = reason;
    };

    const originalGatewaySend = function (op, payload, flag) {
        gatewayFrames.push([op, payload, flag]);
        return 'gateway-sent';
    };

    const socket = {
        sessionId: connected ? 'old-session' : null,
        seq: connected ? 12 : 0,
        webSocket: ws,
        send: originalGatewaySend,
        close() { closeCount++; },
        connect() { connectCount++; },
    };
    let gatewayConnected = connected;
    const gateway = {
        getSocket: () => socket,
        isConnected: () => gatewayConnected,
    };
    const storage = {};
    const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) };
    const RN = { Pressable: 'Pressable', TouchableOpacity: 'TouchableOpacity', View: 'View', Text: 'Text', ScrollView: 'ScrollView' };
    const vendetta = {
        plugin: { storage },
        metro: {
            findByProps: (...names) => names.includes('getSocket') && names.includes('isConnected') ? gateway : null,
            common: { React, ReactNative: RN },
        },
        storage: { useProxy: (value) => value },
        logger: Object.fromEntries(['info', 'warn', 'error', 'log'].map((key) => [key, (...args) => logs.push([key, ...args])])),
        ui: { toasts: { showToast: () => {} } },
    };

    const context = {
        vendetta,
        WebSocket: MockWebSocket,
        setInterval,
        clearInterval,
        setTimeout,
        clearTimeout,
        console: { log: (...args) => consoleMessages.push(args.join(' ')), warn: (...args) => consoleMessages.push(args.join(' ')), error: (...args) => consoleMessages.push(args.join(' ')) },
    };
    const pluginFactory = vm.runInNewContext(`vendetta=>{return ${source}\n}`, context);
    const rawPlugin = pluginFactory(vendetta);
    const plugin = typeof rawPlugin === 'function' ? rawPlugin() : rawPlugin?.default ?? rawPlugin;

    function sendIdentifyViaWebSocket(properties = { os: 'Android', browser: 'Discord Android', device: 'Test Android' }) {
        const frame = JSON.stringify({ op: 2, d: { token: 'not-a-real-token', properties } });
        ws.send(frame);
        return JSON.parse(rawFrames[rawFrames.length - 1]);
    }

    if (prePluginIdentify) {
        // Simulate Discord having already sent its Android IDENTIFY before the
        // plugin's onLoad executes. This first frame cannot be retroactively changed.
        sendIdentifyViaWebSocket();
        gatewayConnected = true;
        ws.readyState = 1;
        socket.sessionId = 'mobile-session';
    }

    return {
        plugin, storage, socket, ws, gateway, rawFrames, gatewayFrames, logs, consoleMessages,
        get closeCount() { return closeCount; },
        get connectCount() { return connectCount; },
        setConnected(value) { gatewayConnected = value; },
        sendIdentifyViaWebSocket,
        originalGatewaySend,
        originalWebSocketSend: MockWebSocket.prototype.send,
        get currentWebSocketSend() { return MockWebSocket.prototype.send; },
    };
}

// Case A: plugin is active before Discord sends its first Gateway IDENTIFY.
{
    const runtime = createRuntime({ connected: false, wsReadyState: 0 });
    runtime.plugin.onLoad();
    assert.strictEqual(runtime.storage.platform, 'desktop');
    assert.strictEqual(runtime.consoleMessages.filter((line) => line.includes('DGATE_READY_V1')).length, 1, 'plugin emits one KernelSU readiness marker');

    const first = runtime.sendIdentifyViaWebSocket();
    assert.deepStrictEqual(first.d.properties, { os: 'Windows', browser: 'Discord Client', device: '' });
    assert.strictEqual(runtime.rawFrames.length, 1, 'early hook should not need a second connection');
    assert.strictEqual(runtime.closeCount, 0, 'no corrective reconnect should be needed when the first IDENTIFY is caught');

    // Platform changes are picked up from storage at send time.
    runtime.ws.readyState = 1;
    const settingsTree = runtime.plugin.settings();
    const webRow = settingsTree.children[4]; // header, description, Off, Desktop, Web
    webRow.props.onPress();
    assert.strictEqual(runtime.storage.platform, 'web');
    const web = runtime.sendIdentifyViaWebSocket();
    assert.deepStrictEqual(web.d.properties, { os: 'Linux', browser: 'Chrome', device: '' });

    // Off reconnects with real Android properties instead of leaving the last spoof active.
    const offRow = runtime.plugin.settings().children[2];
    offRow.props.onPress();
    const off = runtime.sendIdentifyViaWebSocket();
    assert.deepStrictEqual(off.d.properties, { os: 'Android', browser: 'Discord Android', device: 'Test Android' });

    runtime.plugin.onUnload();
    assert.strictEqual(runtime.currentWebSocketSend, runtime.originalWebSocketSend, 'unload restores WebSocket prototype');
    assert.strictEqual(runtime.socket.send, runtime.originalGatewaySend, 'unload restores Gateway socket.send');
}

// Case B: plugin loads after Android IDENTIFY was already sent. It cannot
// erase that initial presence, but it requests one corrected IDENTIFY.
{
    const runtime = createRuntime({ connected: false, wsReadyState: 1, prePluginIdentify: true });
    const beforeLoad = JSON.parse(runtime.rawFrames[0]);
    assert.strictEqual(beforeLoad.d.properties.os, 'Android');

    runtime.plugin.onLoad();
    assert.strictEqual(runtime.closeCount, 1, 'late startup should force one fresh IDENTIFY');
    assert.strictEqual(runtime.socket.sessionId, null);
    assert.strictEqual(runtime.socket.seq, 0);

    // Simulate the Gateway reopening and identifying again.
    runtime.ws.readyState = 1;
    const afterReconnect = runtime.sendIdentifyViaWebSocket();
    assert.deepStrictEqual(afterReconnect.d.properties, { os: 'Windows', browser: 'Discord Client', device: '' });
    assert.strictEqual(runtime.rawFrames.length, 2);
    runtime.plugin.onUnload();
}

console.log('PASS: early IDENTIFY rewrite, late-start corrective reconnect, live platform changes, Off mode, and hook cleanup.');
