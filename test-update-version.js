const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAppVersionPayload } = require('./server');
test('feature release preserves corrective minimum and ignores stale required flag', () => {
    const old = { ...process.env };
    try {
        process.env.APP_LATEST_BUILD = '21';
        process.env.APP_LATEST_VERSION = '1.5.3';
        process.env.APP_UPDATE_REQUIRED = 'true';
        process.env.APP_MINIMUM_BUILD = '21';
        const v = getAppVersionPayload();
        assert.equal(v.latestBuild,30);
        assert.equal(v.latestVersion,'1.6.2');
        assert.equal(v.minimumBuild,27);
        assert.equal(v.updateRequired,false);
        assert.equal(v.apkBytes,68183086);
        assert.equal(v.apkSha256,'bfd4d5ec869afd4a9ab2ada6d4a76c7ad5dbc5de87d4a88198a715b727d09558');
        process.env.APP_LATEST_BUILD = '31';
        process.env.APP_LATEST_VERSION = '1.6.3';
        process.env.APP_UPDATE_REQUIRED = 'false';
        process.env.APP_APK_URL = 'https://example.com/build-31.apk';
        const future = getAppVersionPayload();
        assert.equal(future.updateRequired,false);
        assert.equal(future.minimumBuild,27);
        assert.equal(future.apkSha256,undefined);
        assert.equal(future.apkBytes,undefined);
    } finally { process.env = old; }
});
