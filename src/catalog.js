'use strict';

const { moduleOutsPath, moduleInsPath, PARAMS, tenthsToDb } = require('./paths');

/**
 * buildCatalog(tree)
 * ------------------
 * Walk a full device state tree (the value of a path:"$" update) and produce a
 * FLAT array of parameter entries, each carrying enough metadata to group back
 * into a tree, drive a dropdown, or feed a Stream Deck.
 *
 * This is intentionally GENERIC: it reads whatever modules exist and whatever
 * capabilities they advertise, so it enumerates a Hapi's D/A and mic-pre cards,
 * a Horus's banks, or an Anubis's monitor section without hardcoded knowledge.
 *
 * Entry shape:
 * {
 *   moduleId, moduleName, moduleType, moduleSubType,
 *   section: 'outs'|'ins',
 *   key,                // e.g. 'attenuation', 'mute', 'roll_off_filter'
 *   path,               // device JSONPath to the section object
 *   value,              // current value (dB for tenths-db params, else raw)
 *   raw,                // raw stored value (tenths for db params)
 *   unit,               // 'dB'|'bool'|'enum'|'int'
 *   min, max, step,     // numeric range where advertised (in display units)
 *   enum,               // { label: intValue } for enum params, else null
 *   channelCount,       // for per-channel params
 *   settable,           // true only where we have a confirmed/inferred setter
 *   confidence          // 'confirmed'|'inferred'|'unknown'
 * }
 */
function buildCatalog(tree) {
  const out = [];
  const mods = tree && tree._modules;
  if (!Array.isArray(mods)) return out;

  for (const m of mods) {
    const custom = m && m.custom;
    if (!custom) continue;

    for (const section of ['outs', 'ins']) {
      const sec = custom[section];
      if (!sec) continue;
      const caps = sec.capabilities || {};
      const path = section === 'outs' ? moduleOutsPath(m.id) : moduleInsPath(m.id);
      const channelCount = Array.isArray(sec.channels) ? sec.channels.length : undefined;

      const base = {
        moduleId: m.id,
        moduleName: m.name || null,
        moduleType: m.type,
        moduleSubType: m.sub_type,
        section,
        path,
        channelCount
      };

      // attenuation (gain/volume)
      if (typeof sec.attenuation === 'number' && caps.attenuation) {
        const info = caps.attenuation_info || {};
        out.push(Object.assign({}, base, {
          key: 'attenuation',
          raw: sec.attenuation,
          value: tenthsToDb(sec.attenuation),
          unit: 'dB',
          min: info.min != null ? tenthsToDb(info.min) : null,
          max: info.max != null ? tenthsToDb(info.max) : null,
          step: info.step != null ? tenthsToDb(info.step) : null,
          enum: null,
          settable: true,
          confidence: PARAMS.attenuation.confidence
        }));
      }

      // mute
      if (typeof sec.mute === 'boolean' && caps.mute) {
        out.push(Object.assign({}, base, {
          key: 'mute', raw: sec.mute, value: sec.mute, unit: 'bool',
          min: null, max: null, step: null, enum: null,
          settable: true, confidence: PARAMS.mute.confidence
        }));
      }

      // roll-off filter (enum)
      if (typeof sec.roll_off_filter === 'number' && caps.roll_off_filter) {
        out.push(Object.assign({}, base, {
          key: 'roll_off_filter', raw: sec.roll_off_filter, value: sec.roll_off_filter,
          unit: 'enum', min: null, max: null, step: null,
          enum: caps.roll_off_filters || null,
          settable: true, confidence: PARAMS.roll_off_filter.confidence
        }));
      }

      // out max level (model-supplied enum: device gives only the int)
      if (typeof sec.out_max_level === 'number' && caps.out_max_level) {
        out.push(Object.assign({}, base, {
          key: 'out_max_level', raw: sec.out_max_level, value: sec.out_max_level,
          unit: 'enum', min: null, max: null, step: null, enum: PARAMS.out_max_level.enum || null,
          settable: true, confidence: PARAMS.out_max_level.confidence
        }));
      }

      // per-channel trim
      if (Array.isArray(sec.channels) && caps.channel && caps.channel.trim) {
        const info = (caps.channel && caps.channel.trim_info) || {};
        sec.channels.forEach((ch, idx) => {
          if (ch && typeof ch.trim === 'number') {
            out.push(Object.assign({}, base, {
              key: 'channel_trim', channelIndex: idx,
              raw: ch.trim, value: tenthsToDb(ch.trim), unit: 'dB',
              min: info.min != null ? tenthsToDb(info.min) : null,
              max: info.max != null ? tenthsToDb(info.max) : null,
              step: info.step != null ? tenthsToDb(info.step) : null,
              enum: null,
              settable: true, confidence: PARAMS.channel_trim.confidence
            }));
          }
        });
      }
    }
  }
  return out;
}

/** Convenience: catalog grouped by module, for tree-style display. */
function groupByModule(catalog) {
  const map = new Map();
  for (const e of catalog) {
    if (!map.has(e.moduleId)) {
      map.set(e.moduleId, { moduleId: e.moduleId, moduleName: e.moduleName, moduleType: e.moduleType, params: [] });
    }
    map.get(e.moduleId).params.push(e);
  }
  return Array.from(map.values());
}

module.exports = { buildCatalog, groupByModule };
