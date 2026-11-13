import { mkdirSync } from 'node:fs';
import config, { validateConfig } from './config.js';
import { createApp } from './app.js';

async function main() {
  const errors = validateConfig(config);
  if (errors.length) {
    console.error('配置错误：');
    for (const error of errors) console.error(` - ${error}`);
    process.exit(1);
  }
  mkdirSync(config.dataDir, { recursive: true });
  const { app, services, close } = createApp({ config });
  const server = app.listen(config.port, config.host, () => {
    console.log(`galaxy-collapse listening on http://${config.host}:${config.port}`);
    services.log.write({
      level: 'info',
      scope: 'system',
      event: 'system.start',
      message: `服务启动 http://${config.host}:${config.port}`,
      details: { db: config.dbPath, editorType: services.settings.get('editorType') },
    });
  });

  let closing = false;
  const shutdown = signal => {
    if (closing) return;
    closing = true;
    console.log(`收到 ${signal}，正在关闭…`);
    services.log.write({ level: 'info', scope: 'system', event: 'system.stop', message: `关闭：${signal}` });
    server.close(() => {
      close();
      process.exit(0);
    });
    setTimeout(() => {
      close();
      process.exit(0);
    }, 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(error => {
  console.error('启动失败：', error?.message ?? error);
  process.exit(1);
});
