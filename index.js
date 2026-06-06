'use strict';

const { RavennaEngine } = require('./src/engine');
const { buildCatalog, groupByModule } = require('./src/catalog');
const { KNOWN, checkCompat, describeCompat } = require('./src/compat');
const paths = require('./src/paths');

module.exports = {
  RavennaEngine,
  buildCatalog,
  groupByModule,
  paths,
  compat: { KNOWN, checkCompat, describeCompat }
};
