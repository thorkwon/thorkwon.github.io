const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function harness() {
    let clock = 0, nextRaf = 0, closedFrames = 0, decoders = 0;
    const decoderInstances = [];
    const rafs = new Map(), updates = [], statuses = [];
    class Decoder {
        constructor(callbacks) { this.callbacks = callbacks; this.decodeQueueSize = 0; this.closed = false; decoders++; decoderInstances.push(this); }
        configure() {}
        decode(chunk) {
            this.decodeQueueSize++;
            queueMicrotask(() => {
                this.decodeQueueSize--;
                if (!this.closed) this.callbacks.output({ timestamp: chunk.timestamp, close() { closedFrames++; } });
                this.ondequeue?.();
            });
        }
        flush() { return Promise.resolve(); }
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
    const player = new context.ViewerPlayer({ getCanvas: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, clearRect() {} }) }),
        onUpdate: v => updates.push(v), onCameraStatus: (cam, status) => statuses.push([cam, status]), onEnded: () => ended++ });
    return { player, updates, statuses, decoderInstances, advance(ms) { clock += ms; const callbacks = [...rafs.values()]; rafs.clear(); callbacks.forEach(fn => fn(clock)); },
        get ended() { return ended; }, get decoders() { return decoders; }, get closedFrames() { return closedFrames; } };
}
const file = durations => ({ arrayBuffer: async () => ({ durations }) });
const settle = () => new Promise(resolve => setImmediate(resolve));

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

test('sequential playback reuses decoder and backward seek rebuilds it', async () => {
    const h = harness();
    await h.player.load({ files: { front: file(Array(30).fill(100)) } }, {});
    await settle();
    await h.player.seek(600); await settle();
    assert.equal(h.decoders, 1);
    await h.player.seek(0); await settle();
    assert.equal(h.decoders, 2);
    h.player.destroy();
    assert.ok(h.closedFrames > 0);
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
