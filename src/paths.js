'use strict';

/**
 * paths.js
 * --------
 * Knowledge about the RAVENNA control grammar, kept separate from connection
 * logic so that new parameters (or new devices like Anubis) slot in here.
 *
 * The device addresses parameters with a JSONPath into its state tree, e.g.
 *   $._modules[?(@.id==60)][0].custom.outs
 * and you SET by publishing { path, value } to /service/ravenna/settings,
 * where `value` is a *partial* object merged into the node at `path`.
 *
 * CONFIDENCE levels reflect how sure we are of a parameter's SET shape:
 *   'confirmed' - observed in a captured set frame from a real device
 *   'inferred'  - derived from the state/capability shape; very likely correct
 *   'unknown'   - discoverable (we can read its value) but no verified setter
 */

/** Build the standard module "outs" path. */
function moduleOutsPath(moduleId) {
  return `$._modules[?(@.id==${moduleId})][0].custom.outs`;
}

/** Build the standard module "ins" path (mic pre gains etc. live here on input cards). */
function moduleInsPath(moduleId) {
  return `$._modules[?(@.id==${moduleId})][0].custom.ins`;
}

/**
 * Regex to recognise a feedback frame's path as belonging to a given module's outs.
 * Matches e.g. _modules[?(@.id==60)][0].custom.outs (with or without leading $.).
 */
function moduleOutsPathRegex(moduleId) {
  return new RegExp(`_modules\\[\\?\\(@\\.id==${moduleId}\\)\\]\\[0\\]\\.custom\\.outs`);
}

/**
 * Parameter descriptors. `unit` drives value encoding:
 *   'tenths-db' : device stores integer tenths of a dB; library converts to/from dB
 *   'bool'      : boolean
 *   'enum'      : integer mapped to a label set (from capabilities.roll_off_filters etc.)
 *   'int'       : raw integer
 */
const PARAMS = {
  attenuation: {
    section: 'outs', unit: 'tenths-db', confidence: 'confirmed',
    capInfo: 'attenuation_info',
    build: (v) => ({ attenuation: v })            // v already in tenths
  },
  // All four below CONFIRMED on hardware (fw 1.9.0b62872) via an active set->re-read:
  // the `.custom.outs` set shape actually applies for each. See scripts/set-probe.js.
  mute: {
    section: 'outs', unit: 'bool', confidence: 'confirmed',
    capFlag: 'mute',
    build: (v) => ({ mute: !!v })
  },
  roll_off_filter: {
    section: 'outs', unit: 'enum', confidence: 'confirmed',
    capEnum: 'roll_off_filters',
    build: (v) => ({ roll_off_filter: v | 0 })
  },
  // out_max_level selects the card's output reference level. The device exposes only
  // the raw int (0/1) with NO label map, so the meanings are MODEL knowledge encoded
  // here (Hapi MkII D/A, sub_type 218; may differ on other cards). Confirmed mapping.
  out_max_level: {
    section: 'outs', unit: 'enum', confidence: 'confirmed',
    capFlag: 'out_max_level',
    enum: { '+18 dBu': 0, '+24 dBu': 1 },
    build: (v) => ({ out_max_level: v | 0 })
  },
  // Per-channel trim is an array within custom.outs; the partial-array shape (target
  // channel carries {trim}, others {}) is confirmed to apply on the device.
  channel_trim: {
    section: 'outs', unit: 'tenths-db', confidence: 'confirmed',
    capInfo: 'channel.trim_info', perChannel: true,
    build: (v, ctx) => {
      // ctx: { channelCount, channelIndex }
      const arr = [];
      for (let i = 0; i < (ctx.channelCount || 1); i++) {
        arr.push(i === ctx.channelIndex ? { trim: v } : {});
      }
      return { channels: arr };
    }
  }
};

/** dB -> device tenths (rounded). */
function dbToTenths(db) { return Math.round(db * 10); }
/** device tenths -> dB. */
function tenthsToDb(t) { return Math.round(t) / 10; }

module.exports = {
  moduleOutsPath,
  moduleInsPath,
  moduleOutsPathRegex,
  PARAMS,
  dbToTenths,
  tenthsToDb
};
