import { buildServices } from '../src/app.js';

export function testConfig(overrides = {}) {
  return {
    root: process.cwd(),
    dbPath: ':memory:',
    dataDir: 'data',
    publishTimeoutMs: 20000,
    maxTitleLength: 100,
    gamekee: { baseUrl: 'https://www.gamekee.com', gameId: '829', alias: 'ba', cookieFile: '' },
    bili: { mid: '', name: '', mode: 'dynamic', cookieFile: '' },
    ai: { enabled: false, baseUrl: '', apiKey: '', model: 'mock', timeoutMs: 5000, minConfidence: 0.6 },
    allowedOrigins: [],
    ...overrides,
  };
}

export function makeServices({ settings = {}, fetchImpl } = {}) {
  const services = buildServices({ config: testConfig() });
  services.review.fetchImpl = fetchImpl ?? services.review.fetchImpl;
  if (Object.keys(settings).length) services.settings.update(settings);
  return services;
}
