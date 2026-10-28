'use strict';
const config = require('./config');
const { buildApp } = require('./app');

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const { server, db, media } = buildApp({ dbPath: config.dbPath, dataDir: config.dataDir, adminDist: config.adminDist, publicUrl: config.publicUrl, log });
server.listen(config.port, config.host, () => {
  log(`inhousechannel server listening on http://${config.host}:${config.port} (data: ${config.dataDir})`);
});

function shutdown(sig) {
  log(`${sig} received, shutting down`);
  media.stop();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
