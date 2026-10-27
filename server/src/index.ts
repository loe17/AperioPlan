import { buildApp } from './app';
import { config } from './config';
import { startScheduler } from './services/scheduler';

const { app, ctx } = await buildApp();
startScheduler(ctx, app.log);
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} empfangen – fahre herunter`);
    await app.close();
    process.exit(0);
  });
}
