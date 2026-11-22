// The host scripts carry a version (first line, registry, report): the WhatsOnMyNet version in which they last
// changed. Software distribution filters on it to find machines with an outdated script - so a change to a script
// without a new number would go unnoticed, and a new number without a change would send everyone rolling out again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { scriptSource, SCRIPT_VERSIONS } from '../src/hostscripts.js';

const known = JSON.parse(fs.readFileSync(new URL('./fixtures/hostscript-versions.json', import.meta.url), 'utf8'));

test('a host script (Windows, Hyper-V, Linux) that changed has a new version number (and only then)', () => {
  for (const kind of Object.keys(SCRIPT_VERSIONS)) {
    const sha256 = crypto.createHash('sha256').update(scriptSource(kind)).digest('hex');
    const was = known[kind];
    if (sha256 !== was.sha256) {
      assert.notEqual(SCRIPT_VERSIONS[kind], was.version,
        `${kind}: the script changed - set SCRIPT_VERSIONS.${kind} in src/hostscripts.js to the coming release, then in test/fixtures/hostscript-versions.json: "version": "<it>", "sha256": "${sha256}"`);
      assert.fail(`${kind}: new version ${SCRIPT_VERSIONS[kind]} - note it in test/fixtures/hostscript-versions.json: "version": "${SCRIPT_VERSIONS[kind]}", "sha256": "${sha256}"`);
    }
    assert.equal(SCRIPT_VERSIONS[kind], was.version, `${kind}: version changed, the script did not - machines would count as outdated for nothing`);
  }
});
