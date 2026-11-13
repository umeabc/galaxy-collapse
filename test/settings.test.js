import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServices } from './helpers.js';

test('设置：select 提交的字符串数字按 enum 校验并归一为数字', () => {
  const services = makeServices();
  services.settings.update({ editorType: '1', gamekeeType: '4', sourceMode: 'article' });
  const snapshot = services.settings.getSnapshot();
  assert.equal(snapshot.editorType, 1);
  assert.equal(snapshot.gamekeeType, 4);
  assert.equal(snapshot.sourceMode, 'article');
});

test('设置：密钥只回掩码，空值不覆盖已保存密钥', () => {
  const services = makeServices();
  services.settings.update({ aiApiKey: 'sk-test-1234567890' });
  const view = services.settings.getPublic();
  assert.notEqual(view.aiApiKey, 'sk-test-1234567890');
  assert.equal(view.aiApiKeySet, true);
  // 前端提交掩码视为「不修改」；显式空串（API）才清空。
  services.settings.update({ aiApiKey: view.aiApiKey });
  assert.equal(services.settings.getSnapshot().aiApiKey, 'sk-test-1234567890');
  services.settings.update({ aiApiKey: '' });
  assert.equal(services.settings.getSnapshot().aiApiKey, '');
});

test('设置：非法值与未知键被拒绝', () => {
  const services = makeServices();
  assert.throws(() => services.settings.update({ publishWindowStart: '9:00' }), /HH:mm/);
  assert.throws(() => services.settings.update({ nope: 1 }), /未知设置项/);
  assert.throws(() => services.settings.update({ sourceMode: 'video' }), /dynamic\/article/);
});

test('设置：GameKee Cookie 文本只回「已保存」状态', () => {
  const services = makeServices();
  const cookieText = 'userToken=abc.def.ghi; userUid=399789; obs_client_params=%7B%22bucket_name%22%3A%22wiki-obs%22%7D';
  services.settings.update({ gamekeeCookieText: cookieText });
  const view = services.settings.getPublic();
  assert.equal(view.gamekeeCookieText, '');
  assert.equal(view.gamekeeCookieTextSet, true);
  assert.equal(services.settings.get('gamekeeCookieText'), cookieText);
  services.settings.update({ gamekeeCookieText: '' });
  assert.equal(services.settings.get('gamekeeCookieText'), '');
  assert.equal(services.settings.getPublic().gamekeeCookieTextSet, false);
});
