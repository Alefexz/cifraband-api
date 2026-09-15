const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAppVersionPayload } = require('./server');
test('feature release overrides stale variables and preserves the security minimum', () => {
    const old = { ...process.env };
    try {
        process.env.APP_LATEST_BUILD = '21';
        process.env.APP_LATEST_VERSION = '1.5.3';
        process.env.APP_UPDATE_REQUIRED = 'true';
        process.env.APP_MINIMUM_BUILD = '21';
        const v = getAppVersionPayload();
        assert.equal(v.latestBuild,26);
        assert.equal(v.latestVersion,'1.5.8');
        assert.equal(v.minimumBuild,25);
        assert.equal(v.updateRequired,false);
        assert.equal(v.apkBytes,67428662);
        assert.equal(v.apkSha256,'c9837b6cbcee4e8a744cd0e4eff17611f6c4801ac597f0f381725e0371135ff1');
        process.env.APP_LATEST_BUILD = '27';
        process.env.APP_LATEST_VERSION = '1.5.9';
        process.env.APP_UPDATE_REQUIRED = 'false';
        process.env.APP_APK_URL = 'https://example.com/build-27.apk';
        const future = getAppVersionPayload();
        assert.equal(future.updateRequired,false);
        assert.equal(future.minimumBuild,25);
        assert.equal(future.apkSha256,undefined);
        assert.equal(future.apkBytes,undefined);
    } finally { process.env = old; }
});
