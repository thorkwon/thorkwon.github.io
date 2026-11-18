/* Sidebar and camera surfaces for the local dashcam viewer. */
(function (global) {
    'use strict';

    const cameras = global.ViewerClips.cameras.map(id => [id, global.ViewerClips.labels[id]]);

    function hasCamera(available, camera) {
        if (!available) return false;
        if (available instanceof Map || available instanceof Set) return available.has(camera);
        if (Array.isArray(available)) return available.includes(camera);
        return Boolean(available[camera]);
    }

    function button(label, handler, className) {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = label;
        if (className) element.className = className;
        element.addEventListener('click', handler);
        return element;
    }

    class ViewerUI {
        constructor(callbacks = {}) {
            this.callbacks = callbacks;
            this.clips = [];
            this.activeClip = -1;
            this.available = [];
            this.selected = 'all';
            this.urls = [];
            this.cells = new Map();
            this.cameraButtons = new Map();
            const main = document.querySelector('.main');
            const video = main.querySelector('.video-section');
            this.videoWrap = video.querySelector('.video-wrap');
            this.aside = document.createElement('aside');
            this.aside.className = 'viewer-sidebar';
            this.aside.setAttribute('aria-label', '카메라 및 클립');
            main.insertBefore(this.aside, video);

            const actions = document.createElement('div');
            actions.className = 'viewer-actions';
            actions.append(
                button('파일 열기', () => callbacks.onOpenFiles?.()),
                button('폴더 열기', () => callbacks.onOpenFolder?.()),
                button('전체 CSV 추출', () => callbacks.onBatchExport?.())
            );
            this.aside.append(actions);
            const cameraHeading = document.createElement('h2');
            cameraHeading.textContent = 'CAMERAS';
            this.aside.append(cameraHeading);
            const cameraList = document.createElement('div');
            cameraList.className = 'viewer-camera-list';
            for (const [id, label] of [['all', '전체'], ...cameras]) {
                const item = button(label, () => callbacks.onCamera?.(id), 'viewer-camera-button');
                item.setAttribute('aria-pressed', 'false');
                cameraList.append(item);
                this.cameraButtons.set(id, item);
            }
            this.aside.append(cameraList);
            const clipHeading = document.createElement('h2');
            clipHeading.textContent = 'CLIPS';
            this.aside.append(clipHeading);
            this.clipList = document.createElement('div');
            this.clipList.className = 'viewer-clip-list';
            this.aside.append(this.clipList);
            const controls = document.createElement('div');
            controls.className = 'viewer-clip-controls';
            this.previousButton = button('이전 클립', () => callbacks.onPrevious?.());
            this.nextButton = button('다음 클립', () => callbacks.onNext?.());
            const autoLabel = document.createElement('label');
            this.autoAdvance = document.createElement('input');
            this.autoAdvance.type = 'checkbox';
            this.autoAdvance.checked = true;
            this.autoAdvance.addEventListener('change', () => callbacks.onAutoAdvance?.(this.autoAdvance.checked));
            autoLabel.append(this.autoAdvance, document.createTextNode(' 자동으로 다음 클립'));
            controls.append(this.previousButton, this.nextButton, autoLabel);
            this.aside.append(controls);
            this.status = document.createElement('p');
            this.status.className = 'viewer-status';
            this.status.setAttribute('role', 'status');
            this.aside.append(this.status);

            this.grid = document.createElement('div');
            this.grid.id = 'cameraGrid';
            this.grid.className = 'camera-grid';
            for (const [id, label] of cameras) {
                const cell = document.createElement('div');
                cell.className = 'camera-cell';
                cell.dataset.camera = id;
                const canvas = document.createElement('canvas');
                canvas.setAttribute('aria-label', `${label} 영상`);
                const name = document.createElement('span');
                name.className = 'camera-name';
                name.textContent = label;
                const status = document.createElement('span');
                status.className = 'camera-status';
                status.textContent = '녹화 없음';
                const select = button(`${label} 확대`, () => callbacks.onCamera?.(this.selected === id ? 'all' : id), 'camera-select');
                cell.append(canvas, name, status, select);
                this.grid.append(cell);
                this.cells.set(id, { cell, canvas, status });
            }
            this.videoWrap.append(this.grid);
            this.setCameras([], 'all');
            this.setClips([]);
        }

        setClips(clips) {
            this.urls.forEach(url => URL.revokeObjectURL(url));
            this.urls = [];
            this.clips = clips || [];
            this.clipList.replaceChildren();
            this.clips.forEach((clip, index) => {
                const item = button('', () => this.callbacks.onClip?.(index), 'viewer-clip');
                const thumbnail = clip.thumb || clip.thumbnail || clip.thumbnailBlob;
                if (thumbnail) {
                    const img = document.createElement('img');
                    img.alt = '';
                    if (thumbnail instanceof Blob) {
                        img.src = URL.createObjectURL(thumbnail);
                        this.urls.push(img.src);
                    } else {
                        img.src = thumbnail;
                    }
                    item.append(img);
                }
                const detail = document.createElement('span');
                const time = document.createElement('strong');
                const value = clip.timestamp ?? clip.prefix ?? clip.date ?? clip.name ?? '날짜 없음';
                time.textContent = value instanceof Date ? value.toLocaleString('ko-KR') : String(value);
                const count = document.createElement('small');
                const entries = clip.cameras || clip.files || {};
                const size = entries instanceof Map || entries instanceof Set ? entries.size : Array.isArray(entries) ? entries.length : Object.keys(entries).length;
                count.textContent = `카메라 ${clip.cameraCount ?? size}개`;
                detail.append(time, count);
                if (clip.folder) {
                    const folder = document.createElement('small');
                    folder.textContent = clip.folder;
                    detail.append(folder);
                }
                item.append(detail);
                this.clipList.append(item);
            });
            this.setActiveClip(this.activeClip < this.clips.length ? this.activeClip : -1);
        }

        setActiveClip(index) {
            this.activeClip = index;
            Array.from(this.clipList.children).forEach((item, i) => {
                item.classList.toggle('active', i === index);
                if (i === index) item.setAttribute('aria-current', 'true');
                else item.removeAttribute('aria-current');
            });
            this.previousButton.disabled = index <= 0;
            this.nextButton.disabled = index < 0 || index >= this.clips.length - 1;
        }

        setCameras(available, selected = this.selected) {
            this.available = available;
            this.selected = selected;
            for (const [id, label] of cameras) {
                this.cells.get(id)?.cell.querySelector('.camera-select')?.setAttribute('aria-label', selected === id ? '전체 카메라 보기' : `${label} 확대`);
            }
            for (const [id, item] of this.cameraButtons) {
                item.disabled = id !== 'all' && !hasCamera(available, id);
                item.setAttribute('aria-pressed', String(id === selected));
            }
        }

        setStatus(text) { this.status.textContent = text || ''; }
        getCanvas(camera) { return this.cells.get(camera)?.canvas || null; }

        showCamera(mode, available = this.available) {
            this.videoWrap.classList.add('multi-view');
            this.grid.classList.toggle('single-camera', mode !== 'all');
            for (const [id, entry] of this.cells) {
                entry.cell.hidden = mode !== 'all' && mode !== id;
            }
        }

        setCameraStatus(camera, text) {
            const entry = this.cells.get(camera);
            if (!entry) return;
            entry.status.textContent = text || '';
            entry.status.hidden = !text;
            entry.cell.classList.toggle('has-status', Boolean(text));
        }

        destroy() {
            this.urls.forEach(url => URL.revokeObjectURL(url));
            this.urls = [];
            this.aside.remove();
            this.grid.remove();
            this.videoWrap.classList.remove('multi-view');
        }
    }

    global.ViewerUI = ViewerUI;
})(globalThis);
