#!/usr/bin/env node
'use strict';
// inhousechannel server CLI (install.sh uses it to seed the first account):
//   node src/cli.js create-superadmin <email> <password>
//   node src/cli.js set-password <email> <password>
//   node src/cli.js count-users
const config = require('./config');
const { openDb, migrate } = require('./db');
const { createUser, hashPassword, normEmail } = require('./auth');

function main(argv) {
  const [cmd, ...args] = argv;
  const db = openDb(config.dbPath);
  migrate(db);
  switch (cmd) {
    case 'create-superadmin': {
      const [email, password] = args;
      if (!email || !password) { console.error('usage: cli.js create-superadmin <email> <password>'); process.exit(2); }
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(normEmail(email))) { console.error(`${normEmail(email)} already exists (use set-password)`); process.exit(1); }
      const u = createUser(db, { email, password, is_superadmin: true });
      console.log(`superadmin ${u.email} created (id ${u.id})`);
      break;
    }
    case 'set-password': {
      const [email, password] = args;
      if (!email || !password) { console.error('usage: cli.js set-password <email> <password>'); process.exit(2); }
      if (String(password).length < 8) { console.error('password must be at least 8 characters'); process.exit(1); }
      const n = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(password), normEmail(email)).changes;
      if (!n) { console.error('no such user'); process.exit(1); }
      db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(normEmail(email));
      console.log('password updated');
      break;
    }
    case 'count-users':
      console.log(db.prepare('SELECT COUNT(*) n FROM users').get().n);
      break;
    default:
      console.error('usage: cli.js create-superadmin <email> <password> | set-password <email> <password> | count-users');
      process.exit(2);
  }
  db.close();
}
try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
