/* Common-clock, per-camera WebCodecs playback for dashcam clips. */
class ViewerPlayer {
    constructor({ getCanvas, onUpdate = () => {}, onState = () => {}, onEnded = () => {}, onCameraStatus = () => {} }) {
        this.getCanvas = getCanvas;
        this.onUpdate = onUpdate;
        this.onState = onState;
        this.onEnded = onEnded;
        this.onCameraStatus = onCameraStatus;
        this.tracks = new Map();
        this.reference = null;
        this.duration = 0;
        this.time = 0;
        this.playing = false;
        this.generation = 0;
        this.raf = null;
    }

    async load(clip, seiType) {
        this.pause();
        const generation = ++this.generation;
        this._disposeTracks();
        this.time = 0;
        this.duration = 0;
        this.reference = null;
        if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
            throw new Error('WebCodecs VideoDecoder is not supported in this browser');
        }
        const files = clip.files || clip.cameras || clip;
        const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
        const results = await Promise.all(entries.map(async ([cam, value]) => {
            const file = value && value.file ? value.file : value;
            if (!file || typeof file.arrayBuffer !== 'function') return null;
            this.onCameraStatus(cam, '불러오는 중');
            try {
                const buffer = await file.arrayBuffer();
                if (generation !== this.generation) return null;
                const mp4 = new DashcamMP4(buffer);
                const frames = mp4.parseFrames(seiType);
                const config = mp4.getConfig();
                const firstKeyframe = frames.findIndex(frame => frame.keyframe);
                if (firstKeyframe < 0) throw new Error('키프레임이 없습니다');
                const times = [];
                let duration = 0;
                for (let i = 0; i < frames.length; i++) {
                    times.push(duration);
                    const d = config.durations[i];
                    duration += Number.isFinite(d) && d > 0 ? d : 1000 / 30;
                }
                const canvas = this.getCanvas(cam);
                if (!canvas) throw new Error('Canvas not available');
                canvas.width = config.width;
                canvas.height = config.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('Canvas context not available');
                return { cam, file, mp4, frames, times, duration, config, canvas, ctx,
                    decoder: null, decoderGeneration: 0, next: 0, target: -1, displayed: -1,
                    firstKeyframe, queue: new Map(), busy: false, pendingIndex: null,
                    flushing: false, needsKey: false, flushGeneration: 0, failed: false, status: '불러오는 중' };
            } catch (err) {
                if (generation === this.generation) this.onCameraStatus(cam, `오류: ${err.message}`);
                return null;
            }
        }));
        if (generation !== this.generation) return [];
        for (const track of results) if (track) this.tracks.set(track.cam, track);
        this.reference = this.tracks.get('front') || this.tracks.values().next().value || null;
        if (!this.reference) throw new Error('재생할 수 있는 카메라 영상이 없습니다');
        for (const track of this.tracks.values()) this.duration = Math.max(this.duration, track.duration);
        await this.seek(0);
        if (generation !== this.generation) return [];
        if (!this.reference) throw new Error('재생할 수 있는 카메라 영상이 없습니다');
        return [...this.tracks.values()].filter(track => !track.failed).map(track => track.cam);
    }

    _index(track, time) {
        let lo = 0, hi = track.times.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (track.times[mid] <= time) lo = mid + 1;
            else hi = mid;
        }
        return Math.max(0, lo - 1);
    }

    _status(track, text) {
        if (track.status !== text) {
            track.status = text;
            this.onCameraStatus(track.cam, text);
        }
    }

    _closeDecoder(track) {
        track.busy = false;
        track.pendingIndex = null;
        track.decoderGeneration++;
        track.flushGeneration++;
        if (track.decoder) {
            try { track.decoder.close(); } catch (_) { /* already closed */ }
            track.decoder = null;
        }
        for (const frame of track.queue.values()) frame.close();
        track.queue.clear();
        track.flushing = false;
    }

    _reset(track, index) {
        const displayed = this.playing && index >= track.displayed ? track.displayed : -1;
        track.needsKey = false;
        let key = index;
        while (key >= 0 && !track.frames[key].keyframe) key--;
        if (key < 0) throw new Error('No preceding keyframe');
        if (track.decoder && track.decoder.state !== 'closed') {
            track.flushGeneration++;
            track.decoder.reset();
            for (const frame of track.queue.values()) frame.close();
            track.queue.clear();
            track.flushing = false;
            track.decoder.configure({ codec: track.config.codec, width: track.config.width, height: track.config.height });
            track.next = key;
            track.displayed = displayed;
            return;
        }
        this._closeDecoder(track);
        const generation = track.decoderGeneration;
        const decoder = new VideoDecoder({
            output: frame => {
                if (generation !== track.decoderGeneration || track.failed) { frame.close(); return; }
                // Chunks carry integer microseconds; allow for rounding down by up to 0.5 µs.
                const index = this._index(track, frame.timestamp / 1000 + 0.001);
                const previous = track.queue.get(index);
                if (previous) previous.close();
                track.queue.set(index, frame);
                this._present(track);
                this._pump(track);
            },
            error: err => {
                if (generation === track.decoderGeneration) this._fail(track, err);
            }
        });
        track.decoder = decoder;
        decoder.ondequeue = () => {
            if (generation === track.decoderGeneration) this._pump(track);
        };
        decoder.configure({ codec: track.config.codec, width: track.config.width, height: track.config.height });
        track.next = key;
        track.displayed = displayed;
    }

    _fail(track, err) {
        track.failed = true;
        this._closeDecoder(track);
        if (this.reference === track) {
            this.reference = [...this.tracks.values()].find(candidate => !candidate.failed) || null;
            if (!this.reference) this.pause();
            this._emitUpdate();
        }
        this._status(track, `오류: ${err.message || err}`);
    }

    _emitUpdate() {
        const track = this.reference;
        let index = track && this.time < track.duration ? this._index(track, this.time) : -1;
        if (track && index < track.firstKeyframe) index = -1;
        this.onUpdate({ time: this.time, duration: this.duration, track,
            frame: index < 0 ? null : track.frames[index], index });
    }

    _present(track) {
        let best = -1;
        for (const index of track.queue.keys()) if (index <= track.target && index > best) best = index;
        for (const [index, frame] of track.queue) {
            if (index <= track.target) {
                if (index === best && index >= track.displayed && (this.playing || index === track.target)) {
                    try { track.ctx.drawImage(frame, 0, 0); track.displayed = index; }
                    catch (err) { frame.close(); track.queue.delete(index); this._fail(track, err); return; }
                }
                frame.close();
                track.queue.delete(index);
            }
        }
        this._advanceTrack(track);
    }

    _advanceTrack(track) {
        if (!track.flushing && track.busy && track.displayed === track.target) {
            track.busy = false;
            const generation = track.decoderGeneration;
            // Let the current output callback finish before starting another decode sequence.
            Promise.resolve().then(() => {
                if (generation !== track.decoderGeneration || track.failed || track.busy) return;
                const index = track.pendingIndex;
                track.pendingIndex = null;
                if (index !== null) this._seekTrack(track, index);
            });
        }
    }

    _seekTrack(track, index) {
        try {
            if (!track.decoder || (track.needsKey && index !== track.displayed && !track.queue.has(index)) || (index < track.target && index !== track.displayed && !track.queue.has(index)) || index > track.next + 60) {
                this._reset(track, index);
            }
            track.target = index;
            track.busy = true;
            track.waitStarted = performance.now();
            this._status(track, this.time >= track.duration ? '종료' : '');
            this._present(track);
            this._pump(track);
        } catch (err) { this._fail(track, err); }
    }

    _pump(track) {
        if (!track.decoder || track.failed || track.flushing || track.needsKey) return;
        try {
            // A small lookahead accommodates decoder reordering while bounding output frames.
            const limit = Math.min(track.frames.length, track.target + 9);
            while (track.next < limit && track.decoder.decodeQueueSize < 16 && track.queue.size < 16) {
                const i = track.next++;
                const frame = track.frames[i];
                const sc = new Uint8Array([0, 0, 0, 1]);
                const data = frame.keyframe
                    ? DashcamMP4.concat(sc, frame.sps || track.config.sps, sc, frame.pps || track.config.pps, sc, frame.data)
                    : DashcamMP4.concat(sc, frame.data);
                track.decoder.decode(new EncodedVideoChunk({ type: frame.keyframe ? 'key' : 'delta',
                    timestamp: Math.round(track.times[i] * 1000), data }));
            }
            // A retained target must not block the latest request indefinitely.
            if (track.next >= limit && (!this.playing || track.next === track.frames.length ||
                (track.busy && track.displayed !== track.target && performance.now() - track.waitStarted >= 250)) && !track.flushing) {
                track.flushing = true;
                const generation = track.decoderGeneration;
                const flushGeneration = track.flushGeneration;
                track.decoder.flush().then(() => {
                    if (generation !== track.decoderGeneration || flushGeneration !== track.flushGeneration) return;
                    track.needsKey = true;
                    track.flushing = false;
                    this._advanceTrack(track);
                }).catch(err => {
                    if (generation === track.decoderGeneration && flushGeneration === track.flushGeneration) this._fail(track, err);
                });
            }
        } catch (err) { this._fail(track, err); }
    }

    async seek(timeMs) {
        if (!this.reference) return;
        this.time = Math.max(0, Math.min(this.duration, Number.isFinite(timeMs) ? timeMs : 0));
        if (this.playing) { this.anchorTime = this.time; this.anchorClock = performance.now(); }
        for (const track of this.tracks.values()) {
            if (track.failed) continue;
            // Ended tracks still seek to their last frame, including pending seeks.
            if (this.time >= track.duration) this._status(track, '종료');
            const index = this._index(track, this.time);
            if (index < track.firstKeyframe) {
                this._closeDecoder(track);
                track.target = -1;
                track.displayed = -1;
                track.ctx.clearRect(0, 0, track.canvas.width, track.canvas.height);
                this._status(track, '녹화 없음');
                continue;
            }
            if (track.busy) {
                track.pendingIndex = index;
                this._pump(track);
            }
            else {
                track.pendingIndex = null;
                this._seekTrack(track, index);
            }
        }
        this._emitUpdate();
    }

    setReference(camera) {
        const requested = this.tracks.get(camera);
        const front = this.tracks.get('front');
        const track = (requested && !requested.failed && requested) || (front && !front.failed && front)
            || [...this.tracks.values()].find(candidate => !candidate.failed);
        if (!track) return;
        this.reference = track;
        return this.seek(this.time);
    }

    step(delta) {
        if (!this.reference) return;
        this.pause();
        const track = this.reference;
        const index = Math.min(track.frames.length - 1, Math.max(0, this._index(track, Math.min(this.time, track.duration)) + delta));
        return this.seek(track.times[index]);
    }

    play() {
        if (!this.reference || this.playing) return;
        if (this.time >= this.duration) this.seek(0);
        if (!this.reference) return;
        this.playing = true;
        this.anchorTime = this.time;
        this.anchorClock = performance.now();
        this.onState(true);
        const tick = now => {
            if (!this.playing) return;
            const time = Math.min(this.duration, this.anchorTime + now - this.anchorClock);
            // seek updates the playback anchor; preserve the original monotonic origin.
            const anchorTime = this.anchorTime, anchorClock = this.anchorClock;
            this.seek(time);
            this.anchorTime = anchorTime; this.anchorClock = anchorClock;
            if (!this.playing) return;
            if (time >= this.duration) { this.pause(); this.onEnded(); }
            else this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
    }

    pause() {
        if (this.raf !== null) cancelAnimationFrame(this.raf);
        this.raf = null;
        if (this.playing) { this.playing = false; this.onState(false); }
    }

    _disposeTracks() {
        for (const track of this.tracks.values()) this._closeDecoder(track);
        this.tracks.clear();
    }

    destroy() {
        this.pause();
        ++this.generation;
        this._disposeTracks();
        this.reference = null;
        this.duration = 0;
        this.time = 0;
    }
}
