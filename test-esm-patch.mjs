import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const netCjs = req('net');
netCjs.createConnection = function() { return 'patched'; };

const netEsm = await import('net');
console.log('cjs:', netCjs.createConnection());
console.log('esm default:', netEsm.default.createConnection());
console.log('esm named:', netEsm.createConnection === netCjs.createConnection ? 'patched' : 'original');
