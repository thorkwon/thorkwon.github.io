/* Real H.264/SEI smoke checks. Requires a six-camera recording and local Chrome. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '..');
const directory = process.env.TEST_CLIP_DIR;
const executablePath = process.env.CHROME_PATH;
if (!directory || !executablePath) throw new Error('Set TEST_CLIP_DIR to a six-camera clip folder and CHROME_PATH to a Chrome executable.');
const files = fs.readdirSync(directory).filter(name => /\.mp4$/i.test(name)).map(name => path.resolve(directory, name));
assert.equal(files.length, 6, 'Use exactly six camera MP4 files from one recording interval.');
const server = http.createServer((request, response) => {
    let filename;
    try { filename = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname)); }
    catch { response.writeHead(400).end(); return; }
    if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    fs.readFile(filename, (error, data) => {
        if (error) { response.writeHead(404).end(); return; }
        response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(filename)] || 'application/octet-stream');
        response.end(data);
    });
});
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await puppeteer.launch({ executablePath, headless: true });
        const page = await browser.newPage();
        const errors = [], external = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(base + '/')) external.push(request.url()); });
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(base + '/sei_explorer.html');
        await page.waitForSelector('.viewer-sidebar');
        const pickerClicks = await page.evaluate(() => {
            const clicks = [];
            const file = document.querySelector('#fileInput'), folder = document.querySelector('#folderInput');
            const record = event => { clicks.push(event.target.id); event.preventDefault(); };
            file.addEventListener('click', record);
            folder.addEventListener('click', record);
            [...document.querySelectorAll('.viewer-actions button')].find(button => button.textContent === '폴더 열기').click();
            file.removeEventListener('click', record);
            folder.removeEventListener('click', record);
            return clicks;
        });
        assert.deepEqual(pickerClicks, ['folderInput']);
        await page.evaluate(() => {
            const load = ViewerPlayer.prototype.load;
            ViewerPlayer.prototype.load = function (...args) { globalThis.testPlayer = this; return load.apply(this, args); };
            globalThis.downloads = [];
            document.querySelector('#fileInput').addEventListener('change', event => { if (!globalThis.originalFiles) globalThis.originalFiles = [...event.target.files]; }, { capture: true });
            DashcamHelpers.downloadBlob = (blob, filename) => downloads.push({ blob, filename });
        });
        await (await page.$('#fileInput')).uploadFile(...files);
        await page.waitForFunction(() => !document.querySelector('#playBtn').disabled, { timeout: 60000 });
        await page.waitForFunction(() => [...testPlayer.tracks.values()].every(track => track.displayed === 0), { timeout: 30000 });
        assert.equal(await page.evaluate(() => testPlayer.tracks.size), 6);
        assert.equal(await page.$$eval('.camera-status:not([hidden])', cells => cells.length), 0);
        assert.equal(await page.$eval('.viewer-clip', clip => clip.getAttribute('aria-current')), 'true');
        assert.equal(await page.$eval('.viewer-clip-controls input', checkbox => checkbox.checked), true);
        console.log('PASS: six cameras loaded');
        await page.click('#playBtn');
        await page.waitForFunction(() => testPlayer.time > 1500);
        await page.click('#playBtn');
        assert.equal(await page.evaluate(() => testPlayer.playing), false);
        assert.equal(await page.evaluate(() => [...testPlayer.tracks.values()].every(track => !track.failed && track.queue.size <= 16)), true);
        await page.evaluate(() => {
            const slider = document.querySelector('#slider');
            for (const value of [5000, 20000, 1000, 30000]) { slider.value = value; slider.dispatchEvent(new Event('input')); }
        });
        await page.waitForFunction(() => [...testPlayer.tracks.values()].every(track => track.displayed === track.target && track.target >= 0), { timeout: 30000 });
        assert.equal(await page.evaluate(() => testPlayer.time), 30000);
        // Move focus away from the slider so the document's frame shortcuts apply.
        await page.click('.header h1');
        const before = await page.evaluate(() => testPlayer.reference.target);
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(index => testPlayer.reference.displayed === index, {}, before + 1);
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction(index => testPlayer.reference.displayed === index, {}, before);
        console.log('PASS: playback and frame steps');
        await page.evaluate(() => [...document.querySelectorAll('.viewer-camera-button')].find(button => button.textContent === '후방').click());
        assert.equal(await page.evaluate(() => testPlayer.reference.cam), 'back');
        assert.equal(await page.$$eval('.camera-cell:not([hidden])', cells => cells.length), 1);
        assert.match(await page.$eval('#fileName', element => element.textContent), /back\.mp4$/);
        await page.click('#exportBtn');
        const csv = await page.evaluate(async () => ({ name: downloads[0].filename, text: await downloads[0].blob.text() }));
        assert.match(csv.name, /back_sei\.csv$/);
        assert.match(csv.text, /vehicle_speed_mps/);
        assert.ok(csv.text.split('\n').length > 2);
        await page.evaluate(() => [...document.querySelectorAll('.viewer-actions button')].find(button => button.textContent.includes('CSV')).click());
        await page.waitForFunction(() => downloads.length === 2, { timeout: 60000 });
        const zip = await page.evaluate(async () => {
            const archive = await JSZip.loadAsync(downloads[1].blob);
            return Object.keys(archive.files).filter(name => name.endsWith('.csv'));
        });
        assert.equal(zip.length, 6);
        await page.click('.camera-cell[data-camera="back"] .camera-select');
        assert.equal(await page.$$eval('.camera-cell:not([hidden])', cells => cells.length), 6);
        await page.click('.camera-cell[data-camera="back"] .camera-select');
        assert.equal(await page.$$eval('.camera-cell:not([hidden])', cells => cells.length), 1);
        assert.equal(await page.evaluate(() => testPlayer.reference.cam), 'back');
        console.log('PASS: CSV and ZIP');
        await page.setViewport({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        // Simulate multiple clips from the same local blobs and immediately switch twice.
        await page.evaluate(() => {
            const input = document.querySelector('#fileInput');
            const original = originalFiles.find(file => /-front\.mp4$/i.test(file.name));
            globalThis.sampleFile = original;
            const transfer = new DataTransfer();
            for (const prefix of ['2026-01-01_00-00-00', '2026-01-01_00-01-00']) transfer.items.add(new File([original], `${prefix}-front.mp4`));
            input.files = transfer.files;
            input.dispatchEvent(new Event('change'));
            document.querySelectorAll('.viewer-clip')[1].click();
            document.querySelectorAll('.viewer-clip')[0].click();
        });
        await page.waitForFunction(() => !document.querySelector('#playBtn').disabled && testPlayer.tracks.size === 1 && testPlayer.reference.file.name.startsWith('2026-01-01_00-00-00'), { timeout: 60000 });
        console.log('PASS: rapid clip switching');
        await page.evaluate(() => document.querySelector('.viewer-clip-controls input').checked = true);
        await page.evaluate(() => { const input = document.querySelector('.viewer-clip-controls input'); input.dispatchEvent(new Event('change')); testPlayer.seek(testPlayer.duration - 30); testPlayer.play(); });
        await page.waitForFunction(() => testPlayer.reference?.file.name.startsWith('2026-01-01_00-01-00') && !document.querySelector('#playBtn').disabled, { timeout: 60000 });
        assert.equal(await page.evaluate(() => testPlayer.playing), true);
        await page.evaluate(() => {
            const input = document.querySelector('#fileInput'), transfer = new DataTransfer();
            transfer.items.add(new File([sampleFile], 'custom-recording.mp4'));
            input.files = transfer.files; input.dispatchEvent(new Event('change'));
        });
        await page.waitForFunction(() => testPlayer.reference?.file.name === 'custom-recording.mp4' && !document.querySelector('#playBtn').disabled, { timeout: 60000 });
        await page.evaluate(() => {
            testPlayer.pause();
            const input = document.querySelector('#fileInput'), transfer = new DataTransfer();
            transfer.items.add(new File(['broken MP4'], '2026-01-01_00-00-00-front.mp4'));
            transfer.items.add(new File([sampleFile], '2026-01-01_00-00-00-back.mp4'));
            input.files = transfer.files; input.dispatchEvent(new Event('change'));
        });
        await page.waitForFunction(() => !document.querySelector('#playBtn').disabled && testPlayer.tracks.size === 1 && testPlayer.reference.cam === 'back', { timeout: 60000 });
        assert.match(await page.$eval('[data-camera="front"] .camera-status', element => element.textContent), /오류/);
        console.log('PASS: automatic advance, single file, damaged camera');
        await page.evaluate(() => {
            let release;
            const collect = ViewerClips.collectDrop;
            ViewerClips.collectDrop = () => new Promise(resolve => { release = resolve; });
            document.dispatchEvent(new DragEvent('drop', { dataTransfer: new DataTransfer(), bubbles: true }));
            ViewerClips.collectDrop = collect;
            const input = document.querySelector('#fileInput'), transfer = new DataTransfer();
            transfer.items.add(new File([sampleFile], 'latest-choice.mp4'));
            input.files = transfer.files; input.dispatchEvent(new Event('change'));
            release([new File([sampleFile], 'stale-folder-result.mp4')]);
        });
        await page.waitForFunction(() => !document.querySelector('#playBtn').disabled && testPlayer.reference?.file.name === 'latest-choice.mp4', { timeout: 60000 });
        const noSei = await page.evaluate(async () => {
            const buffer = await sampleFile.arrayBuffer();
            const parser = new DashcamMP4(buffer), mdat = parser.findMdat(), view = new DataView(buffer);
            for (let offset = mdat.offset; offset + 4 < mdat.offset + mdat.size;) {
                const length = view.getUint32(offset); offset += 4;
                if (!length || offset + length > buffer.byteLength) break;
                if ((view.getUint8(offset) & 31) === 6) view.setUint8(offset, 12); // Filler NAL replaces optional SEI.
                offset += length;
            }
            const input = document.querySelector('#fileInput'), transfer = new DataTransfer();
            transfer.items.add(new File([buffer], 'without-sei.mp4'));
            input.files = transfer.files; input.dispatchEvent(new Event('change'));
            return true;
        });
        assert.equal(noSei, true);
        await page.waitForFunction(() => !document.querySelector('#playBtn').disabled && testPlayer.reference?.file.name === 'without-sei.mp4' && testPlayer.reference.displayed === 0, { timeout: 60000 });
        assert.equal(await page.evaluate(() => testPlayer.reference.frames.some(frame => frame.sei)), false);
        assert.equal(await page.$eval('#statsOverlay', element => element.classList.contains('visible')), false);
        await page.evaluate(() => queueMicrotask(() => testPlayer._fail(testPlayer.reference, new Error('Simulated asynchronous decoder failure'))));
        await page.waitForFunction(() => document.querySelector('#playBtn').disabled && testPlayer.reference === null);
        assert.equal(await page.$eval('#statsOverlay', element => element.classList.contains('visible')), false);
        assert.equal(await page.evaluate(() => testPlayer.playing), false);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        console.log('PASS: six-camera playback, latest seek, frame steps, focus, CSV/ZIP, mobile, rapid clip switching, automatic advance, single file, damaged track, latest folder selection, no SEI, decoder failure, no external requests');
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
