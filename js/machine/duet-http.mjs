export class DuetHttp {
    constructor(address, request = fetch) {
        this.address = new URL(/^https?:\/\//i.test(address) ? address : 'http://' + address).origin;
        this.request = request;
    }

    async call(endpoint, params, body) {
        const query = new URLSearchParams(params).toString().replaceAll('+', '%20');
        const response = await this.request(this.address + '/rr_' + endpoint + '?' + query, {
            method: body === undefined ? 'GET' : 'POST',
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(body === undefined ? 6000 : 120000)
        });
        if (!response.ok) throw new Error('Duet ' + endpoint + ' returned HTTP ' + response.status);
        if (endpoint === 'reply') return response.text();
        if (endpoint === 'download') return response.arrayBuffer();
        const data = await response.json();
        if (data.err) throw new Error('Duet ' + endpoint + ' returned error ' + data.err);
        return data;
    }

    connect(password = 'reprap') {
        return this.call('connect', { password });
    }

    async send(code) {
        const result = await this.call('gcode', { gcode: code });
        if (!Number.isFinite(result.buff)) throw new Error('Duet did not report its command buffer');
        if (result.buff === 0) throw new Error('Duet command buffer is full. Check controller status before retrying.');
        return result;
    }
}
export function duetProbeRoutine(axis, distance, feed, offset, retract) {
    return [
        'M400', 'M120', 'G21', 'G91', 'M563 P49 S"XYZ-Probe"',
        ...duetProbeTouch(axis, distance, feed, offset), `G1 ${axis}${retract} F${feed}`,
        'M563 P49 D-1 H-1', 'M121', ''
    ].join('\n');
}

function duetProbeTouch(axis, distance, feed, offset) {
    // RRF 3.3 uses the axis value as a tool offset and signed R as the travel limit.
    return [
        'T49', `M585 ${axis}0 F${feed} P0 R${distance}`,
        'if result != 0', '  T-1', '  M563 P49 D-1 H-1', '  M121', `  abort "${axis} probe failed"`,
        'T-1', 'M400', `G10 L20 ${axis}${offset}`
    ];
}

export function duetOutsideCornerRoutine({ corner, inset, xOffset, yOffset, offset, feed }) {
    if (!['FL', 'FR', 'RL', 'RR'].includes(corner) || ![inset, xOffset, yOffset, offset, feed].every(Number.isFinite) ||
        inset <= 0 || xOffset <= 0 || yOffset <= 0 || offset < 6 || feed <= 0) {
        throw new Error('Check the corner inset, probe offsets, and plate thickness before probing.');
    }
    const x = corner.endsWith('R') ? 1 : -1;
    const y = corner.startsWith('R') ? 1 : -1;
    return [
        'M400', 'M120', 'G21', 'G90', 'M563 P49 S"XYZ-Probe"',
        'G10 L20 X0 Y0 Z0', `G0 X${-x * inset} Y${-y * inset}`,
        ...duetProbeTouch('Z', -25, feed, offset),
        `G0 Z${offset + 5}`, `G0 X${x * 20} Y${-y * 10}`, `G0 Z${offset - 6}`,
        ...duetProbeTouch('X', -x * 25, feed, x * xOffset),
        `G0 X${x * (xOffset + 2)}`, `G0 Z${offset + 15}`,
        `G0 Y${y * 20}`, `G0 X${-x * 15}`, `G0 Z${offset - 6}`,
        ...duetProbeTouch('Y', -y * 25, feed, y * yOffset),
        `G0 Y${y * (yOffset + 2)}`, `G0 Z${offset + 5}`, 'G0 X0 Y0',
        'M563 P49 D-1 H-1', 'M121', ''
    ].join('\n');
}

export function duetCornerProbeRoutine({ corner, width, depth, xOffset, yOffset, diameter, height, zOffset, feed }) {
    const xSign = corner.endsWith('R') ? -1 : 1;
    const ySign = corner.startsWith('B') ? -1 : 1;
    if (corner === 'FR' || corner === 'BL') {
        [width, depth] = [depth, width];
        [xOffset, yOffset] = [yOffset, xOffset];
    }
    const radius = diameter / 2;
    const sideHeight = 5 + height / 2;
    return [
        'M400', 'M120', 'G21', 'G91', 'M563 P49 S"XYZ-Probe"',
        `G1 Z5 F${feed}`,
        `G1 X${(width / 2 - xOffset) * xSign} Y${(depth / 2 - yOffset) * ySign} F${feed}`,
        ...duetProbeTouch('Z', -10, feed, zOffset),
        `G1 Z5 F${feed}`, `G1 X${-(width / 2 + 5 + radius) * xSign} F${feed}`, `G1 Z-${sideHeight} F${feed}`,
        ...duetProbeTouch('X', 10 * xSign, feed, -(xOffset + radius) * xSign),
        `G1 X${-5 * xSign} F${feed}`, `G1 Z${sideHeight} F${feed}`,
        `G1 X${(5 + width / 2) * xSign} Y${-(depth / 2 + 5 + radius) * ySign} F${feed}`, `G1 Z-${sideHeight} F${feed}`,
        ...duetProbeTouch('Y', 10 * ySign, feed, -(yOffset + radius) * ySign),
        `G1 Y${-5 * ySign} F${feed}`, `G1 Z${sideHeight} F${feed}`,
        'M563 P49 D-1 H-1', 'M121', ''
    ].join('\n');
}

export function duetCommand(code) {
    if (/^\$H[XYZ]?$/i.test(code)) return 'G28' + (code.length === 3 ? ' ' + code[2].toUpperCase() : '');
    if (/^\$J=G91 G(?:20|21) (?:[XYZ][+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*)+F\d+(?:\.\d+)?$/i.test(code)) {
        const [, units, move] = /^\$J=G91 (G20|G21) (.*)$/i.exec(code);
        return ['M120', units, 'G91', 'G1 ' + move, 'M121'].join('\n');
    }
    if (code.startsWith('$F=')) {
        const path = code.slice(3);
        if (!path.startsWith('/') || /["\x00-\x1f]/.test(path)) return null;
        return 'M32 "0:' + path + '"';
    }
    if (code.startsWith('$')) return null;
    return code;
}
