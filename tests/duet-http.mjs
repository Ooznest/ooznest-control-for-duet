import assert from 'node:assert/strict';
import { DuetHttp, duetProbeRoutine, duetCornerProbeRoutine } from '../js/machine/duet-http.mjs';

for (const axis of ['X', 'Y']) {
    for (const sign of [-1, 1]) {
        const routine = duetProbeRoutine(axis, sign * 8, 50, -sign * 3, -sign * 5);
        const lines = routine.split('\n');
        const touch = lines.indexOf(`M585 ${axis}0 F50 P0 R${sign * 8}`);
        assert.ok(touch >= 0);
        assert.equal(lines[touch + 1], 'if result != 0');
        assert.deepEqual(lines.slice(touch + 2, touch + 6), [
            '  T-1', '  M563 P49 D-1 H-1', '  M121', `  abort "${axis} probe failed"`
        ]);
        assert.deepEqual(lines.slice(touch + 8, touch + 10), [
            `G10 L20 ${axis}${-sign * 3}`, `G1 ${axis}${-sign * 5} F50`
        ]);
    }
}

const duet = new DuetHttp('192.168.251.2', async (url, options) => {
    assert.equal(url, 'http://192.168.251.2/rr_gcode?gcode=M115%20%3B%20test');
    assert.equal(options.method, 'GET');
    return Response.json({ buff: 250 });
});
assert.equal((await duet.send('M115 ; test')).buff, 250);

const { duetCommand } = await import('../js/machine/duet-http.mjs');
assert.equal(duetCommand('$H'), 'G28');
assert.equal(duetCommand('$HX'), 'G28 X');
assert.equal(duetCommand('$J=G91 G21 X1 Y-2 F300'), 'M120\nG21\nG91\nG1 X1 Y-2 F300\nM121');
assert.equal(duetCommand('$J=G91 G21 X1 F300\nM3'), null);
assert.equal(duetCommand('$F=/gcodes/Test File.gcode'), 'M32 "0:/gcodes/Test File.gcode"');
assert.equal(duetCommand('$F='), null);
assert.equal(duetCommand('$F=undefined'), null);
assert.equal(duetCommand('$F=/gcodes/bad"name.gcode'), null);

const busyDuet = new DuetHttp('192.168.251.2', async () => Response.json({ buff: 0 }));
await assert.rejects(busyDuet.send('M115'), /command buffer is full/);

const { readFileSync } = await import('node:fs');
const { test } = await import('node:test');

test('Original Outside Corner workflow stops before setting an offset on a failed Duet touch', async () => {
    const { duetOutsideCornerRoutine } = await import('../js/machine/duet-http.mjs');
    for (const corner of ['FL', 'FR', 'RL', 'RR']) {
        const lines = duetOutsideCornerRoutine({
            corner, inset: 22.5, xOffset: 8, yOffset: 8, offset: 10, feed: 50
        }).split('\n');
        const touches = lines.filter(line => line.startsWith('M585'));
        assert.deepEqual(touches, [
            'M585 Z0 F50 P0 R-25',
            'M585 X0 F50 P0 R' + (corner.endsWith('R') ? -25 : 25),
            'M585 Y0 F50 P0 R' + (corner.startsWith('R') ? -25 : 25)
        ]);
        for (const touch of touches) {
            const index = lines.indexOf(touch);
            assert.equal(lines[index + 1], 'if result != 0');
            assert.match(lines[index + 5], /^  abort /);
            assert.match(lines[index + 8], /^G10 L20 [XYZ]/);
        }
    }
});

test('Duet batch Save updates only the edited startup parameters', async () => {
    const source = readFileSync(new URL('../js/machine/connection-manager.js', import.meta.url), 'utf8');
    const method = source.match(/^    async prepareDuetAxisFiles\([^\r\n]*\) \{[\s\S]*?^    \}/m)?.[0];
    assert.ok(method);
    const { prepareDuetAxisFiles } = new Function('return ({' + method + '})')();
    const limits = 'M208 X0 Y0 Z0 S1 ; minima\r\nM208 X270 Y270 Z88 ; maxima';
    const calibration = 'M92 X400 Y400 Z400 ; steps/mm\n';
    const duet = {
        async call(endpoint, { name }) {
            assert.equal(endpoint, 'download');
            return new TextEncoder().encode(name.endsWith('limits.g') ? limits : calibration);
        }
    };
    const files = await prepareDuetAxisFiles(duet, [
        { axis: 'X', code: 'M208 S0', next: 271 },
        { axis: 'Y', code: 'M208 S1', next: -1 },
        { axis: 'Z', code: 'M92', next: 401.5 }
    ]);
    assert.deepEqual(files.map(file => file.updated), [
        'M208 X0 Y-1 Z0 S1 ; minima\r\nM208 X271 Y270 Z88 ; maxima',
        'M92 X400 Y400 Z401.5 ; steps/mm\n'
    ]);
    await assert.rejects(prepareDuetAxisFiles(duet, [{ axis: 'A', code: 'M92', next: 200 }]), /Expected one M92 value/);
});
test('Web Serial can retry after a busy port', async () => {
    const { WebSerial } = await import('../js/machine/webserial.js');
    const serial = new WebSerial();
    serial.readLoop = () => {};
    const port = { open: async () => { throw new Error('Port busy'); } };

    await assert.rejects(serial.connectToPort(port), /Port busy/);
    assert.equal(serial.port, null);
    assert.equal(serial.isConnected, false);

    port.open = async ({ baudRate }) => assert.equal(baudRate, 115200);
    await serial.connectToPort(port);
    assert.equal(serial.port, port);
    assert.equal(serial.isConnected, true);
});
test('Duet corner probing follows the selected orientation and checks every touch', () => {
    for (const [corner, xDirection, yDirection, xContact, yContact] of [
        ['FL', 0, 0, -8, -13],
        ['FR', 1, 0, 13, -8],
        ['BL', 0, 1, -13, 8],
        ['BR', 1, 1, 8, 13]
    ]) {
        const lines = duetCornerProbeRoutine({
            corner, width: 40, depth: 60, xOffset: 5, yOffset: 10,
            diameter: 6, height: 12, zOffset: 2, feed: 50
        }).trimEnd().split('\n');
        assert.deepEqual(lines.filter(line => line.startsWith('M585')), [
            'M585 Z0 F50 P0 R-10', `M585 X0 F50 P0 R${xDirection ? -10 : 10}`, `M585 Y0 F50 P0 R${yDirection ? -10 : 10}`
        ]);
        assert.deepEqual(lines.filter(line => line.startsWith('G10 L20')), [
            'G10 L20 Z2', `G10 L20 X${xContact}`, `G10 L20 Y${yContact}`
        ]);
        for (const axis of ['Z', 'X', 'Y']) {
            const touch = lines.findIndex(line => line.startsWith('M585 ' + axis));
            assert.equal(lines[touch + 1], 'if result != 0');
            assert.equal(lines[touch + 5], `  abort "${axis} probe failed"`);
            assert.ok(lines[touch + 8].startsWith('G10 L20 ' + axis));
        }
    }
});
test('Duet only runs a probe routine after matching SD readback', async () => {
    const source = readFileSync(new URL('../js/machine/connection-manager.js', import.meta.url), 'utf8');
    const method = source.match(/^    probeDuetAxis\([^\r\n]*\) \{[\s\S]*?^    \}/m)?.[0];
    assert.ok(method, 'Missing Duet probe entry point');
    for (const { matches, state, homed, probeValue = 0, triggerAfterUpload = false } of [
        { matches: false, state: 'O', homed: 0 },
        { matches: false, state: 'I', homed: 0 },
        { matches: false, state: 'I', homed: 1, probeValue: 500 },
        { matches: false, state: 'I', homed: 1 },
        { matches: true, state: 'I', homed: 1, triggerAfterUpload: true },
        { matches: true, state: 'I', homed: 1 }
    ]) {
        let confirm, saved, error;
        let uploads = 0;
        const commands = [];
        const controller = new Function('window', 'duetProbeRoutine', 'return ({' + method + '})')({
            reporter: { showConfirm(_title, message, callback) {
                assert.match(message, /18 mm at 50 mm\/min, setting Z to 2 mm/);
                confirm = callback;
            } }
        }, duetProbeRoutine);
        controller.emit = (_event, failure) => { error = failure; };
        controller.duet = {
            async call(endpoint, params, body) {
                if (endpoint === 'status') {
                    return { status: state, coords: { axesHomed: [1, 1, homed] }, currentTool: -1,
                        sensors: { probeValue: triggerAfterUpload && uploads ? 500 : probeValue },
                        probe: { threshold: 500, type: 1 } };
                }
                assert.equal(params.name, '0:/sys/probe.g');
                if (endpoint === 'upload') {
                    uploads++;
                    saved = body;
                    const routine = new TextDecoder().decode(body);
                    assert.match(routine, /^M585 Z0 F50 P0 R-18$/m);
                    assert.match(routine, /^G10 L20 Z2$/m);
                    return;
                }
                assert.equal(endpoint, 'download');
                return matches ? saved : new Uint8Array();
            },
            async send(command) { commands.push(command); }
        };
        controller.probeDuetAxis({ elements: {
            height: { valueAsNumber: 10 }, offset: { valueAsNumber: 2 }, feed: { valueAsNumber: 50 }
        } });
        await Promise.all([confirm(), confirm()]);
        const ready = state === 'I' && homed === 1 && probeValue < 500;
        assert.equal(uploads, ready ? 1 : 0);
        assert.equal(controller.duetProbePending, false);
        assert.deepEqual(commands, matches && !triggerAfterUpload ? ['M98 P"probe.g"'] : []);
        if (triggerAfterUpload) assert.match(error.message, /already triggered/);
        else if (matches) assert.equal(error, undefined);
        else assert.match(error.message, ready ? /did not match/ : probeValue >= 500 ? /already triggered/ : /must be idle with Z homed/);
    }
});

test('Duet allows jog and home commands only while Idle over HTTP and USB', async () => {
    const source = readFileSync(new URL('../js/machine/connection-manager.js', import.meta.url), 'utf8');
    const method = source.match(/^    async sendCommand\([^\r\n]*\) \{[\s\S]*?^    \}/m)?.[0];
    assert.ok(method);
    for (const transport of ['http', 'usb']) {
        const sent = [];
        const send = command => sent.push(command);
        const errors = [];
        const controller = new Function('duetCommand', 'return ({' + method + '})')(duetCommand);
        Object.assign(controller, {
            duet: transport === 'http' ? { send } : null,
            isDuetSerial: transport === 'usb',
            duetState: 'O',
            flowControl: { sendCommand: send },
            emit: (_event, error) => errors.push(error.message)
        });
        await controller.sendCommand('$J=G91 G21 X1 F300');
        await controller.sendCommand('$HX');
        assert.deepEqual(errors, Array(2).fill('The Duet must be powered and idle to jog or home'));
        assert.deepEqual(sent, []);

        controller.duetState = 'I';
        await controller.sendCommand('$J=G91 G21 X1 F300');
        await controller.sendCommand('$HX');
        const jog = ['M120', 'G21', 'G91', 'G1 X1 F300', 'M121'];
        assert.deepEqual(sent, transport === 'http' ? [jog.join('\n'), 'G28 X'] : [...jog, 'G28 X']);
    }
});

test('Duet SD preview keeps the selected path through confirmation', async () => {
    const source = readFileSync(new URL('../js/features/sdcard.js', import.meta.url), 'utf8');
    const method = source.match(/^    async preview\([^\r\n]*\) \{[\s\S]*?^    \}/m)?.[0];
    assert.ok(method);
    let confirmDownload;
    const requests = [];
    const handler = new Function('window', 'return ({' + method + '})')({
        reporter: { showConfirm(_title, _message, callback) { confirmDownload = callback; } }
    });
    const duet = { async call(endpoint, params) {
        requests.push([endpoint, params.name]);
        return new TextEncoder().encode('G4 P500');
    } };
    Object.assign(handler, {
        ws: { duet }, path: '/gcodes', files: {},
        term: { writeln() {} }, _toggleProgressUI() {}, _finishDownload() { this.isDownloading = false; }
    });
    await handler.preview('test.gcode');
    handler.path = '/sys';
    await confirmDownload();
    assert.deepEqual(requests, [['download', '0:/gcodes/test.gcode']]);
    assert.equal(handler.downloadBuffer, 'G4 P500');

    await handler.preview('test.gcode');
    handler.ws.duet = {};
    await confirmDownload();
    assert.equal(requests.length, 1);
});

test('Duet recovery checks all system-file pages and waits for confirmation', async () => {
    const source = readFileSync(new URL('../js/features/job-control.js', import.meta.url), 'utf8');
    const method = source.match(/^    async recoverDuetJob\(\) \{[\s\S]*?^    \}/m)?.[0];
    assert.ok(method);
    const pages = [];
    const commands = [];
    let confirm;
    const duet = {
        async call(endpoint, params) {
            assert.equal(endpoint, 'filelist');
            assert.equal(params.dir, '0:/sys');
            pages.push(params.first);
            return params.first === 0
                ? { files: [], next: 7 }
                : { files: [{ name: 'resurrect.g', type: 'f' }] };
        },
        async send(command) { commands.push(command); }
    };
    const ws = { duet, duetState: 'I', emit: (_event, error) => { throw error; } };
    const controller = new Function('window', 'return ({' + method + '})')({
        ws, reporter: { showConfirm(_title, _message, callback) { confirm = callback; } }
    });
    controller._hasActiveJob = () => false;
    await controller.recoverDuetJob();
    assert.deepEqual(pages, [0, 7]);
    assert.deepEqual(commands, []);
    assert.equal(typeof confirm, 'function');
    ws.duetState = 'O';
    await confirm();
    assert.deepEqual(commands, []);

    ws.duetState = 'I';
    await controller.recoverDuetJob();
    await confirm();
    assert.deepEqual(commands, ['M916']);
});
