'use strict';

const { RavennaEngine } = require('./src/engine');
const { buildCatalog, groupByModule } = require('./src/catalog');
const { KNOWN, checkCompat, describeCompat } = require('./src/compat');
const { SYSTEM, readSystem, groupSystem, systemWriteFrame } = require('./src/system');
const paths = require('./src/paths');

module.exports = {
  RavennaEngine,
  buildCatalog,
  groupByModule,
  paths,
  system: { SYSTEM, readSystem, groupSystem, systemWriteFrame },
  compat: { KNOWN, checkCompat, describeCompat }
};
