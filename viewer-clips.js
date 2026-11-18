(function (root) {
  'use strict';

  const cameras = ['right_pillar', 'front', 'left_pillar', 'right_repeater', 'back', 'left_repeater'];
  const labels = {
    right_pillar: '우측 필러', front: '전방', left_pillar: '좌측 필러',
    right_repeater: '우측 리피터', back: '후방', left_repeater: '좌측 리피터'
  };
  const cameraPattern = /^(.*)-(right_pillar|front|left_pillar|right_repeater|back|left_repeater)\.mp4$/i;
  const pathOf = file => (file.viewerRelativePath || file.webkitRelativePath || file.name).replace(/\\/g, '/');
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

  function recordingTime(name, elapsedMs) {
    const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-|\.mp4$)/i.exec(name || '');
    if (!match || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, 0);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
    const centiseconds = Math.round(elapsedMs / 10);
    date.setTime(date.getTime() + centiseconds * 10);
    const pad = value => String(value).padStart(2, '0');
    return `${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}.${pad(centiseconds % 100)}s`;
  }

  function parseFiles(input) {
    const files = Array.from(input).sort((a, b) => compare(pathOf(a), pathOf(b)));
    const groups = new Map();
    const metadata = new Map();
    const warnings = [];
    const standalone = [];
    for (const file of files) {
      const path = pathOf(file);
      const slash = path.lastIndexOf('/');
      const folder = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      const lower = name.toLowerCase();
      if (lower === 'event.json' || lower === 'thumb.png' || lower === 'thumb.jpg' || lower === 'thumbnail.png') {
        const info = metadata.get(folder) || { eventJson: null, thumb: null };
        const field = lower === 'event.json' ? 'eventJson' : 'thumb';
        if (info[field]) warnings.push(`중복 메타데이터: ${path}`);
        else info[field] = file;
        metadata.set(folder, info);
        continue;
      }
      if (!/\.mp4$/i.test(name)) continue;
      const match = cameraPattern.exec(name);
      if (!match || !match[1]) {
        standalone.push({ id: '', prefix: name.replace(/\.mp4$/i, ''), folder, files: { front: file }, eventJson: null, thumb: null, path });
        continue;
      }
      const prefix = match[1];
      const camera = match[2].toLowerCase();
      const key = JSON.stringify([folder, prefix.toLowerCase()]);
      let clip = groups.get(key);
      if (!clip) {
        clip = { id: key, prefix, folder, files: {}, eventJson: null, thumb: null };
        groups.set(key, clip);
      }
      if (clip.files[camera]) warnings.push(`중복 카메라 파일: ${path} (${camera})`);
      else clip.files[camera] = file;
    }
    const clips = [...groups.values(), ...standalone];
    standalone.forEach((clip, index) => { clip.id = JSON.stringify(['standalone', clip.path, index]); delete clip.path; });
    for (const clip of clips) {
      const info = metadata.get(clip.folder);
      if (info) Object.assign(clip, info);
    }
    clips.sort((a, b) => compare(a.prefix.toLowerCase(), b.prefix.toLowerCase()) || compare(a.folder, b.folder) || compare(a.id, b.id));
    return { clips, warnings };
  }

  async function collectDrop(dataTransfer) {
    const result = [];
    async function visit(entry, parent) {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        Object.defineProperty(file, 'viewerRelativePath', { value: path, configurable: true });
        result.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!entries.length) break;
          for (const child of entries) await visit(child, path);
        }
      }
    }
    const items = Array.from(dataTransfer.items || []);
    const entries = items.map(item => typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null);
    if (entries.some(Boolean)) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i]) await visit(entries[i], '');
        else if (items[i].kind === 'file') {
          const file = items[i].getAsFile();
          if (!file) throw new Error('드롭한 파일을 읽을 수 없습니다.');
          result.push(file);
        }
      }
    } else {
      result.push(...Array.from(dataTransfer.files || []));
    }
    return result;
  }
  root.ViewerClips = { cameras, labels, parseFiles, collectDrop, recordingTime };
})(globalThis);
