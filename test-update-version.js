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
        assert.equal(v.latestBuild,29);
        assert.equal(v.latestVersion,'1.6.1');
        assert.equal(v.minimumBuild,27);
        assert.equal(v.updateRequired,false);
        assert.equal(v.apkBytes,68052014);
        assert.equal(v.apkSha256,'b047b8efd6de5418e4da8d497e5fc74c2aca3a65207b61caf30a8cc24b5f52ca');
        process.env.APP_LATEST_BUILD = '30';
        process.env.APP_LATEST_VERSION = '1.6.2';
        process.env.APP_UPDATE_REQUIRED = 'false';
        process.env.APP_APK_URL = 'https://example.com/build-30.apk';
        const future = getAppVersionPayload();
        assert.equal(future.updateRequired,false);
        assert.equal(future.minimumBuild,27);
        assert.equal(future.apkSha256,undefined);
        assert.equal(future.apkBytes,undefined);
    } finally { process.env = old; }
});
