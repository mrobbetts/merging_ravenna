'use strict';

/**
 * compat.js
 * ---------
 * Known-good device/firmware fingerprints. The control protocol is undocumented
 * and could change between firmware releases, so we record which combinations
 * have actually been validated and warn when we see something we haven't.
 *
 * Matching is GENERATION-AWARE on purpose: Merging ships frequent point builds,
 * and we don't want a scary warning on every new b-number within a firmware
 * generation whose protocol we've already confirmed. A new *generation* or a new
 * *product*, on the other hand, is a real "be careful" signal.
 *
 * Levels returned by checkCompat():
 *   'known-good'        exact product + generation + firmware version validated
 *   'known-generation'  product + generation match; different point release (likely fine)
 *   'unknown-generation' product matches but generation not seen (caution)
 *   'unknown'           product never seen (high caution)
 *
 * `confirmedShapes` documents which parameter SET shapes we have actually verified
 * on this fingerprint (vs. merely inferred), so tools can be honest about it.
 */

const KNOWN = [
  {
    product: 'HAPI_MkII',
    firmwareGeneration: 2,
    firmwareVersions: ['1.9.0b62872'],
    status: 'verified',
    // serial recorded only as provenance of where validation happened
    validatedOn: 'maintainer unit (serial H96149, D/A card sub_type 218, hw run 14)',
    confirmedShapes: ['attenuation', 'mute', 'roll_off_filter', 'out_max_level', 'channel_trim'],
    inferredShapes: [],
    notes: 'All five out-param set-shapes confirmed on hardware: attenuation from captured web-UI frames; mute/roll_off_filter/out_max_level/channel_trim via active set->re-read (scripts/set-probe.js, 2026-06-05). Note the device echoes non-attenuation changes at the module-root path, not .custom.outs.'
  }
];

function checkCompat(tree) {
  const product = (tree && tree.identity && tree.identity.product) || null;
  const fw = (tree && tree._firmware_version) || null;
  const gen = (tree && tree._firmware_generation != null) ? tree._firmware_generation : null;

  const result = { level: 'unknown', product, firmware: fw, generation: gen, entry: null };

  const genMatch = KNOWN.find((k) => k.product === product && k.firmwareGeneration === gen);
  if (genMatch) {
    result.entry = genMatch;
    result.level = genMatch.firmwareVersions.includes(fw) ? 'known-good' : 'known-generation';
    return result;
  }
  const productMatch = KNOWN.find((k) => k.product === product);
  if (productMatch) {
    result.entry = productMatch;
    result.level = 'unknown-generation';
    return result;
  }
  return result;
}

/** Human-readable one-liner for logs / status tooltips. */
function describeCompat(c) {
  const base = `${c.product || 'unknown product'} fw ${c.firmware || '?'} (gen ${c.generation == null ? '?' : c.generation})`;
  switch (c.level) {
    case 'known-good': return `KNOWN-GOOD: ${base} — validated.`;
    case 'known-generation': return `KNOWN-GENERATION: ${base} — same generation as a validated build; protocol almost certainly identical.`;
    case 'unknown-generation': return `UNKNOWN-GENERATION: ${base} — product known but this firmware generation has not been validated. Proceed with caution.`;
    default: return `UNKNOWN: ${base} — this device/firmware has never been validated with this tool. Shapes are unverified.`;
  }
}

module.exports = { KNOWN, checkCompat, describeCompat };
