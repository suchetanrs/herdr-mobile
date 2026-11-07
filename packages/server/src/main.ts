import { createBridge } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const bridge = createBridge(config);

const shutdown = (signal: string) => {
  bridge.http.log.info({ signal }, 'shutting down');
  bridge
    .stop()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

bridge
  .start()
  .then((url) => {
    bridge.http.log.info(
      { url, core: config.socketPath, tokenFile: config.token ? '(HERDR_MOBILE_TOKEN)' : `${config.configDir}/token` },
      'herdr-mobile bridge listening',
    );
  })
  .catch((err: Error) => {
    bridge.http.log.error({ err: err.message }, 'failed to start');
    process.exit(1);
  });
