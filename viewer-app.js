/* Integrates local clip browsing with frame-accurate SEI inspection. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const fileInput = $('fileInput'), folderInput = $('folderInput');
    const dropOverlay = $('dropOverlay'), slider = $('slider');
    const playBtn = $('playBtn'), exportBtn = $('exportBtn');
    const frameNum = $('frameNum'), fileName = $('fileName'), recordingTime = $('recordingTime'), metaList = $('metaList');
    const statsOverlay = $('statsOverlay'), gearText = $('gearText'), speedVal = $('speedVal');
    const steeringSvg = $('steeringSvg'), accelFill = $('accelFill'), autopilot = $('autopilot');
    const blinkerL = statsOverlay.querySelector('.blinker-l'), blinkerR = statsOverlay.querySelector('.blinker-r');
    const brakeEl = statsOverlay.querySelector('.brake');
    let blinkerTimer = null, blinkerState = false, blinkerLeft = false, blinkerRight = false;
    let useMph = false, lastSpeedMps = 0;
    const speedUnit = statsOverlay.querySelector('.speed-unit');
    let seiType, seiFields = [], seiFieldsCsv = [], clips = [], inputFiles = [];
    let clipIndex = -1, cameraMode = 'all', loadGeneration = 0, inputGeneration = 0, loading = false, exporting = false;
    let autoAdvance = true, currentTrack = null, playAfterLoad = false, draggingSlider = false;
    const ui = new ViewerUI({
        onCamera: selectCamera,
        onClip: index => run(() => loadClip(index)),
        onOpenFiles: () => fileInput.click(),
        onOpenFolder: () => folderInput.click(),
        onBatchExport: () => run(exportBatch),
        onPrevious: () => run(() => loadClip(clipIndex - 1)),
        onNext: () => run(() => loadClip(clipIndex + 1)),
        onAutoAdvance: value => { autoAdvance = value; }
    });
    const player = new ViewerPlayer({
        getCanvas: camera => ui.getCanvas(camera),
        onUpdate: updateFrame,
        onState: playing => {
            playBtn.textContent = playing ? '❚❚' : '▶';
            playBtn.setAttribute('aria-label', playing ? '일시 정지' : '재생');
            playBtn.setAttribute('aria-pressed', String(playing));
        },
        onEnded: () => {
            if (autoAdvance && clipIndex + 1 < clips.length) run(() => loadClip(clipIndex + 1, true));
        },
        onCameraStatus: (camera, text) => {
            ui.setCameraStatus(camera, text);
            if (!loading && text.startsWith('오류')) {
                const available = [...player.tracks.values()].filter(track => !track.failed).map(track => track.cam);
                if (!available.includes(cameraMode)) cameraMode = 'all';
                ui.setCameras(available, cameraMode);
                ui.showCamera(cameraMode, Object.keys(clips[clipIndex]?.files || {}));
                ui.setStatus(text);
                controls(available.length > 0);
            }
        }
    });
    const schemaReady = DashcamHelpers.initProtobuf().then(({ SeiMetadata, enumFields }) => {
        seiType = SeiMetadata;
        seiFields = DashcamHelpers.deriveFieldInfo(SeiMetadata, enumFields, { useLabels: true });
        seiFieldsCsv = DashcamHelpers.deriveFieldInfo(SeiMetadata, enumFields, { useSnakeCase: true });
    });
    // Retain the rejection for callers while avoiding an unhandled boot rejection.
    schemaReady.catch(error => ui.setStatus(`스키마 로드 실패: ${error.message}`));

    async function run(action) {
        try { await action(); }
        catch (error) { ui.setStatus(`오류: ${error.message}`); }
    }
    function controls(enabled) {
        playBtn.disabled = slider.disabled = !enabled;
        exportBtn.disabled = !enabled || !currentTrack;
    }
    async function openFiles(files, request) {
        if (request !== inputGeneration) return;
        const parsed = ViewerClips.parseFiles(files);
        if (!parsed.clips.length) { ui.setStatus('MP4 파일을 선택해 주세요.'); return; }
        inputFiles = Array.from(files);
        clips = parsed.clips;
        clipIndex = -1;
        cameraMode = 'all';
        ui.setClips(clips);
        await loadClip(0);
        if (request === inputGeneration && parsed.warnings.length) ui.setStatus(parsed.warnings.join(' / '));
    }
    async function loadClip(index, autoplay = loading ? playAfterLoad : player.playing) {
        if (index < 0 || index >= clips.length) return;
        const generation = ++loadGeneration;
        playAfterLoad = autoplay;
        player.pause();
        loading = true;
        currentTrack = null;
        controls(false);
        renderSei(null);
        clipIndex = index;
        ui.setActiveClip(index);
        const clip = clips[index];
        const cameras = ViewerClips.cameras.filter(camera => clip.files[camera]);
        if (!cameras.includes(cameraMode)) cameraMode = 'all';
        ui.setCameras(cameras, cameraMode);
        ui.showCamera(cameraMode, cameras);
        for (const camera of ViewerClips.cameras) ui.setCameraStatus(camera, cameras.includes(camera) ? '불러오는 중…' : '녹화 없음');
        dropOverlay.classList.add('hidden');
        ui.setStatus(`${clip.prefix} 불러오는 중…`);
        fileName.textContent = clip.prefix;
        frameNum.textContent = '';
        recordingTime.textContent = '시간 정보 없음';
        try {
            await schemaReady;
            if (generation !== loadGeneration) return;
            await player.load(clip, seiType);
            if (generation !== loadGeneration) return;
            const loaded = [...player.tracks.values()].filter(track => !track.failed).map(track => track.cam);
            if (!loaded.length) throw new Error('재생할 수 있는 카메라 영상이 없습니다.');
            if (!loaded.includes(cameraMode)) cameraMode = 'all';
            ui.setCameras(loaded, cameraMode);
            ui.showCamera(cameraMode, cameras);
            player.setReference(cameraMode === 'all' ? (loaded.includes('front') ? 'front' : loaded[0]) : cameraMode);
            await player.seek(0);
            if (generation !== loadGeneration) return;
            ui.setStatus(loaded.length === cameras.length ? `${clips.length}개 클립 · ${loaded.length}개 카메라` : `${loaded.length}/${cameras.length}개 카메라 로드됨 · 오류 표시를 확인하세요.`);
            loading = false;
            controls(true);
            if (playAfterLoad && !document.hidden) player.play();
        } catch (error) {
            if (generation !== loadGeneration) return;
            loading = false;
            controls(false);
            ui.setStatus(`클립 로드 실패: ${error.message}`);
        }
    }
    function selectCamera(mode) {
        if (loading || clipIndex < 0) return;
        if (mode !== 'all' && (!player.tracks.has(mode) || player.tracks.get(mode).failed)) return;
        cameraMode = mode;
        const cameras = [...player.tracks.values()].filter(track => !track.failed).map(track => track.cam);
        ui.setCameras(cameras, mode);
        ui.showCamera(mode, ViewerClips.cameras.filter(camera => clips[clipIndex].files[camera]));
        player.setReference(mode === 'all' ? (cameras.includes('front') ? 'front' : cameras[0]) : mode);
        run(() => player.seek(player.time));
    }
    function updateFrame({ time, duration, track, frame, index }) {
        currentTrack = track || null;
        const maximum = String(Math.max(0, duration));
        if (slider.max !== maximum) slider.max = maximum;
        if (!draggingSlider) slider.value = String(time);
        slider.setAttribute('aria-valuetext', `${(time / 1000).toFixed(2)} / ${(duration / 1000).toFixed(2)}초`);
        fileName.textContent = track ? `${ViewerClips.labels[track.cam] || cameraMode} · ${track.file.name}` : '';
        frameNum.textContent = `${(time / 1000).toFixed(2)} / ${(duration / 1000).toFixed(2)}s · ${frame ? `Frame ${index + 1}/${track.frames.length}` : '녹화 없음'}`;
        recordingTime.textContent = ViewerClips.recordingTime(track?.file.name, time) || '시간 정보 없음';
        exportBtn.disabled = !track;
        renderSei(frame?.sei || null);
    }
    function renderSei(sei) {
        if (metaList.children.length !== seiFields.length) {
            metaList.replaceChildren();
            for (const { label } of seiFields) {
                const item = document.createElement('div');
                item.className = 'item';
                const name = document.createElement('span'), value = document.createElement('span');
                name.className = 'label'; value.className = 'value';
                name.textContent = label;
                item.append(name, value); metaList.append(item);
            }
        }
        for (const [index, { propName, enumMap }] of seiFields.entries()) {
            let raw = sei?.[propName];
            if (propName === 'vehicleSpeedMps' && raw != null) raw *= 3.6;
            const value = metaList.children[index].lastElementChild;
            const text = String(raw != null ? DashcamHelpers.formatValue(raw, enumMap) : '—');
            if (value.textContent !== text) value.textContent = text;
        }
        updateStats(sei);
    }
        function updateStats(sei) {
            if (!sei) {
                statsOverlay.classList.remove('visible');
                if (blinkerTimer) { clearInterval(blinkerTimer); blinkerTimer = null; }
                blinkerLeft = blinkerRight = false;
                return;
            }
            statsOverlay.classList.add('visible');

            const gearMap = { 0: 'P', 1: 'D', 2: 'R', 3: 'N' };
            gearText.textContent = gearMap[sei.gearState] || 'P';

            lastSpeedMps = sei.vehicleSpeedMps || 0;
            speedVal.textContent = Math.round(lastSpeedMps * (useMph ? 2.237 : 3.6));

            const apMap = { 1: 'Full Self-Driving', 2: 'Autosteer', 3: 'TACC' };
            const apText = apMap[sei.autopilotState];
            autopilot.textContent = apText ? `${apText} Active` : '';
            autopilot.classList.toggle('active', !!apText);

            steeringSvg.style.transform = `rotate(${sei.steeringWheelAngle || 0}deg)`;

            brakeEl.classList.toggle('applied', !!sei.brakeApplied);

            const accelPct = Math.max(0, Math.min(1, (sei.acceleratorPedalPosition || 0) / 100));
            const y = 21 - accelPct * 18;
            accelFill.setAttribute('y', y);
            accelFill.setAttribute('height', 21 - y);

            blinkerLeft = !!sei.blinkerOnLeft;
            blinkerRight = !!sei.blinkerOnRight;
            blinkerL.classList.toggle('active', blinkerLeft);
            blinkerR.classList.toggle('active', blinkerRight);
            if (blinkerLeft || blinkerRight) {
                blinkerL.classList.toggle('dim', blinkerLeft && blinkerState);
                blinkerR.classList.toggle('dim', blinkerRight && blinkerState);
                if (!blinkerTimer) blinkerTimer = setInterval(() => {
                    blinkerState = !blinkerState;
                    blinkerL.classList.toggle('dim', blinkerLeft && blinkerState);
                    blinkerR.classList.toggle('dim', blinkerRight && blinkerState);
                }, 400);
            } else {
                blinkerL.classList.remove('dim');
                blinkerR.classList.remove('dim');
                if (blinkerTimer) { clearInterval(blinkerTimer); blinkerTimer = null; }
            }
        }

    async function exportCsv() {
        if (!currentTrack) return;
        const messages = currentTrack.frames.map(frame => frame.sei).filter(Boolean);
        if (!messages.length) { ui.setStatus('현재 카메라에 내보낼 SEI 데이터가 없습니다.'); return; }
        DashcamHelpers.downloadBlob(new Blob([DashcamHelpers.buildCsv(messages, seiFieldsCsv)], { type: 'text/csv' }), currentTrack.file.name.replace(/\.mp4$/i, '_sei.csv'));
    }
    async function exportBatch() {
        if (exporting) return;
        const files = inputFiles.filter(file => /\.mp4$/i.test(file.name));
        if (!files.length) { ui.setStatus('먼저 영상 파일 또는 폴더를 열어 주세요.'); return; }
        exporting = true;
        const zip = new JSZip(), names = new Set(), failures = [];
        let exported = 0;
        try {
            await schemaReady;
            for (const [index, file] of files.entries()) {
                ui.setStatus(`CSV 추출 ${index + 1}/${files.length}`);
                await new Promise(resolve => setTimeout(resolve, 0));
                try {
                    const mp4 = new DashcamMP4(await file.arrayBuffer());
                    const messages = mp4.extractSeiMessages(seiType);
                    if (!messages.length) { failures.push(`${file.name}: SEI 없음`); continue; }
                    let name = (file.viewerRelativePath || file.webkitRelativePath || file.name).replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..').join('/').replace(/\.mp4$/i, '_sei.csv');
                    if (names.has(name)) name = `${index + 1}_${name}`;
                    names.add(name);
                    zip.file(name, DashcamHelpers.buildCsv(messages, seiFieldsCsv));
                    exported++;
                } catch (error) { failures.push(`${file.name}: ${error.message}`); }
            }
            if (exported) DashcamHelpers.downloadBlob(await zip.generateAsync({ type: 'blob' }), 'dashcam_sei_metadata.zip');
            ui.setStatus(`${exported}/${files.length}개 CSV 추출 완료${failures.length ? ` · ${failures.join(' / ')}` : ''}`);
        } finally { exporting = false; }
    }
    fileInput.addEventListener('change', () => { const files = [...fileInput.files], request = ++inputGeneration; fileInput.value = ''; run(() => openFiles(files, request)); });
    folderInput.addEventListener('change', () => { const files = [...folderInput.files], request = ++inputGeneration; folderInput.value = ''; run(() => openFiles(files, request)); });
    folderInput.addEventListener('click', event => event.stopPropagation());
    dropOverlay.addEventListener('click', () => fileInput.click());
    document.addEventListener('dragover', event => { event.preventDefault(); dropOverlay.classList.add('dragover'); });
    document.addEventListener('dragleave', event => { if (!event.relatedTarget) dropOverlay.classList.remove('dragover'); });
    document.addEventListener('drop', event => {
        event.preventDefault(); dropOverlay.classList.remove('dragover');
        // Entries must be captured while the drop data store is readable.
        const request = ++inputGeneration;
        const pending = ViewerClips.collectDrop(event.dataTransfer);
        run(async () => {
            try { await openFiles(await pending, request); }
            catch (error) { if (request === inputGeneration) throw error; }
        });
    });
    playBtn.addEventListener('click', () => { if (!loading) player.playing ? player.pause() : player.play(); });
    slider.step = '1'; slider.setAttribute('aria-label', '공통 재생 시각');
    slider.addEventListener('pointerdown', () => { draggingSlider = true; });
    window.addEventListener('pointerup', () => { draggingSlider = false; });
    window.addEventListener('pointercancel', () => { draggingSlider = false; });
    slider.addEventListener('input', () => {
        player.pause();
        run(() => player.seek(Number(slider.value)));
    });
    exportBtn.addEventListener('click', () => run(exportCsv));
    statsOverlay.querySelector('.speed-click').onclick = () => {
        useMph = !useMph;
        speedUnit.textContent = useMph ? 'mph' : 'km/h';
        speedVal.textContent = Math.round(lastSpeedMps * (useMph ? 2.237 : 3.6));
    };
    document.addEventListener('keydown', event => {
        if (loading || !player.tracks.size || event.target.closest('input, select, textarea, button, [contenteditable="true"]')) return;
        const actions = {
            ' ': () => player.playing ? player.pause() : player.play(),
            ArrowLeft: () => { player.pause(); return player.step(-1); },
            ArrowRight: () => { player.pause(); return player.step(1); },
            ArrowUp: () => loadClip(clipIndex - 1),
            ArrowDown: () => loadClip(clipIndex + 1)
        };
        if (actions[event.key]) { event.preventDefault(); run(actions[event.key]); }
    });
    window.addEventListener('pagehide', event => {
        playAfterLoad = false;
        player.pause();
        if (!event.persisted) { player.destroy(); ui.destroy(); }
        if (blinkerTimer) { clearInterval(blinkerTimer); blinkerTimer = null; }
    });
    window.addEventListener('pageshow', event => {
        if (event.persisted && player.reference) run(() => player.seek(player.time));
    });
})();
