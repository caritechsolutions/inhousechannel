'use strict';
const path = require('path');

// IHC_DATA holds the SQLite DB, media originals + normalised files, thumbnails and player
// thumbnails. PUBLIC_URL is what the pairing command shows players (the NPM hostname).
const dataDir = process.env.IHC_DATA || '/var/lib/inhousechannel/server';

module.exports = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3100),
  dataDir,
  dbPath: process.env.IHC_DB || path.join(dataDir, 'inhousechannel.db'),
  adminDist: process.env.IHC_ADMIN_DIST || path.resolve(__dirname, '..', '..', 'admin', 'dist'),
  publicUrl: process.env.PUBLIC_URL || null,
};
