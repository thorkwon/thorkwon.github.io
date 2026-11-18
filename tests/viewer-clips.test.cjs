const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../viewer-clips.js');
const { parseFiles, collectDrop } = globalThis.ViewerClips;
const file = path => ({ name: path.split('/').pop(), webkitRelativePath: path });

test('파일명과 재생 위치로 시각을 계산하고 날짜 경계와 잘못된 이름을 처리한다', () => {
  const { recordingTime } = globalThis.ViewerClips;
  assert.equal(recordingTime('2026-11-14_14-34-40-front.mp4', 12580), '14-34-52.58s');
  assert.equal(recordingTime('2026-12-31_23-59-59-front.mp4', 1010), '00-00-00.01s');
  assert.equal(recordingTime('2026-02-30_12-00-00-front.mp4', 0), null);
  assert.equal(recordingTime('custom.mp4', 0), null);
});

test('전체 경로와 시각으로 묶고 카메라 대소문자 및 중복을 처리한다', () => {
  const files = [file('a/event/2024-01-01_00-00-00-FRONT.MP4'), file('a/event/2024-01-01_00-00-00-front.mp4'), file('a/event/2024-01-01_00-00-00-Back.mp4'), file('b/event/2024-01-01_00-00-00-front.mp4'), file('a/event/event.json')];
  const { clips, warnings } = parseFiles(files);
  assert.equal(clips.length, 2);
  assert.deepEqual(Object.keys(clips[0].files).sort(), ['back', 'front']);
  assert.equal(clips[0].eventJson, files[4]);
  assert.equal(clips[1].eventJson, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /중복 카메라/);
});

test('인식하지 못한 MP4 각각을 독립 클립으로 유지하고 시간순 정렬한다', () => {
  const { clips } = parseFiles([file('x/z.mp4'), file('x/a.MP4'), file('x/2023-01-01_00-00-00-front.mp4')]);
  assert.deepEqual(clips.map(c => c.prefix), ['2023-01-01_00-00-00', 'a', 'z']);
  assert.equal(new Set(clips.map(c => c.id)).size, 3);
  assert.ok(clips.every(c => c.files.front));
});

test('디렉터리의 여러 배치와 중첩 경로를 모두 읽는다', async () => {
  const entry = name => ({ name, isFile: true, file: resolve => resolve({ name }) });
  const dir = (name, batches) => ({ name, isDirectory: true, createReader: () => ({ readEntries: resolve => resolve(batches.shift() || []) }) });
  const tree = dir('root', [[entry('one.mp4')], [dir('nested', [[entry('two.mp4')], []])], []]);
  const files = await collectDrop({ items: [{ webkitGetAsEntry: () => tree }] });
  assert.deepEqual(files.map(f => f.viewerRelativePath), ['root/one.mp4', 'root/nested/two.mp4']);
  assert.deepEqual(parseFiles(files).clips.map(c => c.folder), ['root', 'root/nested']);
});

test('디렉터리 읽기 오류는 호출자에게 전달한다', async () => {
  const error = new Error('read failed');
  const tree = { name: 'root', isDirectory: true, createReader: () => ({ readEntries: (ok, fail) => fail(error) }) };
  await assert.rejects(collectDrop({ items: [{ webkitGetAsEntry: () => tree }] }), error);
});

test('1개부터 6개까지 카메라 파일을 하나의 클립으로 묶는다', () => {
  const cameras = ['right_pillar', 'front', 'left_pillar', 'right_repeater', 'back', 'left_repeater'];
  for (let count = 1; count <= cameras.length; count++) {
    const inputs = cameras.slice(0, count).map(camera => file(`event/2024-01-01_00-00-00-${camera}.mp4`));
    const { clips, warnings } = parseFiles(inputs);
    assert.equal(clips.length, 1);
    assert.equal(Object.keys(clips[0].files).length, count);
    assert.deepEqual(warnings, []);
  }
});

test('같은 시각이라도 전체 상위 경로가 다르면 분리하고 jpg 썸네일을 연결한다', () => {
  const thumb = file('first/event/thumb.jpg');
  const { clips } = parseFiles([
    file('first/event/2024-01-01_00-00-00-front.mp4'),
    file('second/event/2024-01-01_00-00-00-front.mp4'), thumb
  ]);
  assert.equal(clips.length, 2);
  assert.notEqual(clips[0].id, clips[1].id);
  assert.equal(clips[0].thumb, thumb);
  assert.equal(clips[1].thumb, null);
});

test('entry API가 없으면 DataTransfer 파일 목록을 사용한다', async () => {
  const input = [file('one.mp4'), file('two.mp4')];
  assert.deepEqual(await collectDrop({ items: [{ kind: 'file' }], files: input }), input);
});
