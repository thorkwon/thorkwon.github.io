const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness({ manual = false, buffered = false } = {}) {
    const outputs = [];
    let clock = 0, nextRaf = 0, closedFrames = 0, decoders = 0;
    const decoderInstances = [], drawnFrames = [];
    const rafs = new Map(), updates = [], statuses = [];
    class Decoder {
        constructor(callbacks) { this.callbacks = callbacks; this.decodeQueueSize = 0; this.closed = false; this.resets = 0; this.generation = 0; decoders++; decoderInstances.push(this); }
        configure() {}
        decode(chunk) {
            this.decodeQueueSize++;
            const generation = this.generation;
            const output = () => {
                if (generation !== this.generation) return;
                this.decodeQueueSize--;
                if (!this.closed) this.callbacks.output({ timestamp: chunk.timestamp, close() { closedFrames++; } });
                this.ondequeue?.();
            };
            if (manual || buffered) outputs.push(output); else queueMicrotask(output);
        }
        flush() { if (buffered) while (outputs.length) outputs.shift()(); return Promise.resolve(); }
        reset() { this.resets++; this.generation++; this.decodeQueueSize = 0; }
        close() { this.closed = true; }
    }
    class MP4 {
        constructor(data) { this.data = data; }
        getConfig() { return { codec: 'avc1', width: 1, height: 1, durations: this.data.durations, sps: new Uint8Array(1), pps: new Uint8Array(1) }; }
        parseFrames() { return this.data.durations.map((_, i) => ({ index: i, keyframe: i % 5 === 0, data: new Uint8Array(1) })); }
        static concat(...arrays) { return new Uint8Array(arrays.reduce((n, a) => n + a.length, 0)); }
    }
    const context = { VideoDecoder: Decoder, EncodedVideoChunk: class { constructor(v) { Object.assign(this, v); } }, DashcamMP4: MP4,
        performance: { now: () => clock }, requestAnimationFrame: fn => { const id = ++nextRaf; rafs.set(id, fn); return id; }, cancelAnimationFrame: id => rafs.delete(id) };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../viewer-player.js'), 'utf8') + '\nthis.ViewerPlayer = ViewerPlayer;', context);
    let ended = 0;
    const player = new context.ViewerPlayer({ getCanvas: () => ({ width: 0, height: 0, getContext: () => ({ drawImage(frame) { drawnFrames.push(frame.timestamp); }, clearRect() {} }) }),
        onUpdate: v => updates.push(v), onCameraStatus: (cam, status) => statuses.push([cam, status]), onEnded: () => ended++ });
    return { player, updates, statuses, decoderInstances, drawnFrames, drain() { while (outputs.length) outputs.shift()(); }, advance(ms) { clock += ms; const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(fn => fn(clock)); },
        get ended() { return ended; }, get decoders() { return decoders; }, get closedFrames() { return closedFrames; } };
}
const file = durations => ({ arrayBuffer: async () => ({ durations }) });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('scrubbing updates metadata immediately and waits for output before decoding the latest position', async () => {
    const h = harness({ manual: true });
    await h.player.load({ files: { front: file(Array(100).fill(100)) } }, {});
    h.drain(); await settle();
    await h.player.seek(4000);
    const track = h.player.reference;
    await h.player.seek(2000);
    await h.player.seek(1000);
    assert.equal(h.updates.at(-1).time, 1000);
    assert.equal(track.target, 40);
    assert.equal(track.pendingIndex, 10);
    h.drain(); await settle();
    assert.equal(track.target, 10);
    h.drain(); await settle();
    assert.equal(track.displayed, 10);
    assert.equal(track.busy, false);
    h.player.destroy();
});

test('destroy discards queued scrub work and delayed decoder output', async () => {
    const h = harness({ manual: true });
    await h.player.load({ files: { front: file(Array(100).fill(100)) } }, {});
    await h.player.seek(3000);
    h.player.destroy();
    h.drain(); await settle();
    assert.equal(h.player.reference, null);
    assert.equal(h.decoders, 1);
});

test('a failed camera drops pending work while other cameras finish scrubbing', async () => {
    const h = harness({ manual: true });
    await h.player.load({ files: { front: file(Array(100).fill(100)), back: file(Array(100).fill(100)) } }, {});
    await h.player.seek(3000);
    const front = h.player.reference;
    h.decoderInstances[0].callbacks.error(new Error('Injected decoder failure'));
    assert.equal(front.pendingIndex, null);
    assert.equal(h.player.reference.cam, 'back');
    h.drain(); await settle(); h.drain(); await settle();
    assert.equal(h.player.reference.displayed, 30);
    h.player.destroy();
});

test('common clock ends at longest track and clears reference metadata', async () => {
    const h = harness();
    await h.player.load({ files: { front: file([100, 100]), back: file([100, 100, 100, 100]) } }, {});
    assert.deepEqual(h.statuses.filter(([cam]) => cam === 'front').map(([, status]) => status), ['불러오는 중', '']);
    await settle();
    h.player.play(); h.advance(250);
    assert.equal(h.player.time, 250);
    assert.equal(h.updates.at(-1).frame, null);
    assert.equal(h.ended, 0);
    h.advance(200);
    assert.equal(h.player.time, 400);
    assert.equal(h.ended, 1);
    assert.equal(h.player.playing, false);
    h.player.destroy();
    assert.ok(h.closedFrames > 0);
});

test('seeking to the end displays the last frame and preserves ended status', async () => {
    const h = harness({ buffered: true });
    await h.player.load({ files: { front: file(Array(100).fill(100)), back: file(Array(50).fill(100)) } }, {});
    await settle();
    await h.player.seek(7500); await settle();
    assert.equal(h.player.tracks.get('front').displayed, 75);
    assert.equal(h.player.tracks.get('back').displayed, 49);
    assert.equal(h.player.tracks.get('back').status, '종료');
    await h.player.seek(10000); await settle();
    assert.equal(h.player.reference.displayed, 99);
    assert.equal(h.player.reference.status, '종료');
    assert.equal(h.updates.at(-1).frame, null);
    await h.player.seek(2000); await settle();
    for (const track of h.player.tracks.values()) {
        assert.equal(track.displayed, 20);
        assert.equal(track.status, '');
    }
    h.player.destroy();
});

test('a pending seek to the end finishes at the last frame', async () => {
    const h = harness({ manual: true });
    await h.player.load({ files: { front: file(Array(100).fill(100)) } }, {});
    await h.player.seek(10000);
    h.drain(); await settle(); h.drain(); await settle();
    assert.equal(h.player.reference.displayed, 99);
    assert.equal(h.player.reference.status, '종료');
    assert.equal(h.player.reference.busy, false);
    assert.equal(h.player.reference.pendingIndex, null);
    h.player.destroy();
});

test('sequential playback and seeks reuse the decoder', async () => {
    const h = harness();
    await h.player.load({ files: { front: file(Array(30).fill(100)) } }, {});
    await settle();
    await h.player.seek(600); await settle();
    assert.equal(h.decoders, 1);
    await h.player.seek(0); await settle();
    assert.equal(h.decoders, 1);
    // Forward seek uses cached output; only the backwards seek resets decoding.
    assert.equal(h.decoderInstances[0].resets, 1);
    h.player.destroy();
    assert.ok(h.closedFrames > 0);
});

test('paused seeks flush buffered output and continue from a key frame', async () => {
    const h = harness({ buffered: true });
    await h.player.load({ files: { front: file(Array(100).fill(100)) } }, {});
    await settle();
    h.drawnFrames.length = 0;
    await h.player.seek(3000); await settle();
    assert.deepEqual(h.drawnFrames, [3000000]);
    assert.equal(h.player.reference.displayed, 30);
    assert.equal(h.player.reference.busy, false);
    await h.player.seek(1000); await settle();
    assert.equal(h.player.reference.displayed, 10);
    assert.equal(h.decoders, 1);
    h.player.destroy();
});

test('resuming after a paused seek never paints keyframe preroll backwards', async () => {
    const h = harness();
    await h.player.load({ files: { front: file(Array(100).fill(100)) } }, {});
    await settle();
    await h.player.seek(2300); await settle();
    h.drawnFrames.length = 0;
    h.player.play(); h.advance(100); await settle();
    h.advance(100); await settle();
    assert.ok(h.drawnFrames.length > 0);
    assert.ok(h.drawnFrames.every((time, i) => time >= (i ? h.drawnFrames[i - 1] : 2300000)), String(h.drawnFrames));
    h.player.destroy();
});

test('playback drains retained output after back-and-forth seeks', async () => {
    const h = harness({ buffered: true });
    await h.player.load({ files: { front: file(Array(200).fill(100)) } }, {});
    await settle();
    for (const position of [7300, 2100, 5300, 1200]) {
        h.player.pause();
        await h.player.seek(position); await settle();
        h.player.play();
        h.advance(100); await settle();
        h.advance(300); await settle();
        assert.equal(h.player.reference.displayed, position / 100 + 4);
        assert.equal(h.player.reference.busy, false);
    }
    h.player.destroy();
});

test('normal sequential playback does not repeatedly reset the decoder', async () => {
    const h = harness();
    await h.player.load({ files: { front: file(Array(200).fill(100)) } }, {});
    await settle();
    h.player.play();
    for (let i = 0; i < 50; i++) { h.advance(100); await settle(); }
    assert.ok(h.decoderInstances[0].resets <= 1);
    assert.equal(h.player.reference.displayed, 50);
    h.player.destroy();
});

test('stale load is discarded and empty clips fail', async () => {
    const h = harness();
    let resolve;
    const slow = { arrayBuffer: () => new Promise(r => { resolve = r; }) };
    const old = h.player.load({ files: { front: slow } }, {});
    await h.player.load({ files: { back: file([100]) } }, {});
    resolve({ durations: [100] });
    assert.deepEqual(Array.from(await old), []);
    assert.deepEqual(Array.from(h.player.tracks.keys()), ['back']);
    await assert.rejects(h.player.load({ files: {} }, {}), /재생할 수 있는/);
    h.player.destroy();
});

test('fractional frame times map decoded timestamps to their original index', async () => {
    const h = harness();
    await h.player.load({ files: { front: file(Array(30).fill(1000 / 36)) } }, {});
    await settle();
    await h.player.seek(1000 / 36 * 6);
    await settle();
    const track = h.player.tracks.get('front');
    assert.equal(track.target, 6);
    assert.equal(track.displayed, 6);
    h.player.destroy();
});

test('asynchronous decoder errors switch reference and clear metadata when all fail', async () => {
    const h = harness();
    await h.player.load({ files: { front: file([100, 100]), back: file([100, 100]) } }, {});
    await settle();
    h.player.play();
    h.decoderInstances[0].callbacks.error(new Error('front failed'));
    assert.equal(h.player.reference.cam, 'back');
    assert.equal(h.updates.at(-1).track.cam, 'back');
    h.player.setReference('front');
    assert.equal(h.player.reference.cam, 'back');
    h.decoderInstances[1].callbacks.error(new Error('back failed'));
    assert.equal(h.player.reference, null);
    assert.equal(h.player.playing, false);
    assert.equal(h.updates.at(-1).track, null);
    assert.equal(h.updates.at(-1).frame, null);
    assert.equal(h.updates.at(-1).index, -1);
    h.player.destroy();
});
