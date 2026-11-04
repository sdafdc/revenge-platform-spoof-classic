/* Mocked compatibility smoke test for Revenge Classic's legacy Vd loader. */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync(__dirname + '/../index.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync(__dirname + '/../manifest.json', 'utf8'));
assert.strictEqual(manifest.main, 'index.js');
assert.ok(typeof manifest.hash === 'string' && manifest.hash.length > 0);
assert.ok(manifest.name && Array.isArray(manifest.authors));

const logs = [];
let closed = false;
const originalSend = function (op, payload, flag) {
    this.lastSent = [op, payload, flag];
    return 'sent';
};
const socket = {
    sessionId: 'old-session',
    seq: 42,
    webSocket: {
        readyState: 1,
        close(code) {
            closed = true;
            this.readyState = 3;
            this.closeCode = code;
        },
    },
    send: originalSend,
};
const gateway = { getSocket: () => socket, isConnected: () => true };
const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
};
const RN = {
    Pressable: 'Pressable',
    TouchableOpacity: 'TouchableOpacity',
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
};
const storage = {};
const vendetta = {
    plugin: { storage },
    metro: {
        findByProps: (...names) =>
            names.includes('getSocket') && names.includes('isConnected') ? gateway : null,
        common: { React, ReactNative: RN },
    },
    storage: { useProxy: (value) => value },
    logger: Object.fromEntries(
        ['info', 'warn', 'error', 'log'].map((key) => [key, (...args) => logs.push([key, ...args])]),
    ),
    ui: { toasts: { showToast: () => {} } },
};

// Matches Revenge 1.12.1's evalPlugin construction: vendetta=>{return plugin.js}
const pluginString = `vendetta=>{return ${source}\n}`;
const compiled = vm.runInNewContext(pluginString, {
    setInterval,
    clearInterval,
    setTimeout,
    globalThis: {},
});
const raw = compiled(vendetta);
const plugin = typeof raw === 'function' ? raw() : raw?.default ?? raw;

assert.strictEqual(typeof plugin.onLoad, 'function');
assert.strictEqual(typeof plugin.onUnload, 'function');
assert.strictEqual(typeof plugin.settings, 'function');

plugin.onLoad();
assert.strictEqual(storage.platform, 'desktop');
assert.strictEqual(closed, true, 'plugin should request a fresh IDENTIFY on load');
assert.strictEqual(socket.sessionId, null);
assert.strictEqual(socket.seq, 0);
assert.strictEqual(socket.webSocket.closeCode, 1000);

// The mocked gateway send method receives a Windows desktop IDENTIFY.
socket.webSocket.readyState = 1;
const androidPayload = {
    properties: { os: 'Android', browser: 'Discord Android', device: 'Test Android' },
};
assert.strictEqual(socket.send(2, androidPayload, false), 'sent');
assert.strictEqual(
    JSON.stringify(socket.lastSent[1].properties),
    JSON.stringify({ os: 'Windows', browser: 'Discord Client', device: '' }),
);
assert.strictEqual(androidPayload.properties.os, 'Android', 'input payload must not be mutated');

// Settings UI can render and change the selected platform.
const settingsTree = plugin.settings();
assert.strictEqual(settingsTree.type, 'ScrollView');
assert.ok(settingsTree.children.length >= 8);
const webRow = settingsTree.children[4];
webRow.props.onPress();
assert.strictEqual(storage.platform, 'web');
socket.webSocket.readyState = 1;
socket.send(2, { properties: { os: 'Android', browser: 'Discord Android', device: 'Test Android' } });
assert.strictEqual(
    JSON.stringify(socket.lastSent[1].properties),
    JSON.stringify({ os: 'Linux', browser: 'Chrome', device: '' }),
);

plugin.onUnload();
assert.strictEqual(socket.send, originalSend, 'unload must restore the original gateway send method');
console.log('PASS: legacy loader evaluation, manifest fields, lifecycle, Desktop IDENTIFY, Web selection, settings rendering, and unload restoration.');
