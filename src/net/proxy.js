import { ProxyAgent } from 'undici';

const agents = new Map();

/** 复用 ProxyAgent（代理池级别），避免每次请求新建连接池。 */
export function proxyDispatcher(proxyUrl) {
  if (!proxyUrl) return null;
  if (!agents.has(proxyUrl)) agents.set(proxyUrl, new ProxyAgent(proxyUrl));
  return agents.get(proxyUrl);
}

export function isValidProxy(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export async function fetchWithProxy(url, init = {}, proxyUrl = '', fetchImpl = globalThis.fetch) {
  const dispatcher = proxyDispatcher(proxyUrl);
  return fetchImpl(url, dispatcher ? { ...init, dispatcher } : init);
}

export async function closeProxyAgents() {
  const all = [...agents.values()];
  agents.clear();
  await Promise.allSettled(all.map(agent => agent.close()));
}
